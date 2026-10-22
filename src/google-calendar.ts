/**
 * The host's Google Calendar, read and written directly. This replaced
 * Calendly as the booking backend.
 *
 * Access is a Google service account with domain-wide delegation in the
 * business's Google Workspace: it acts as BOOKING_CALENDAR_OWNER, so every
 * event it writes is the host's own, exactly as Calendly's were. No Google
 * library: the token is a signed JWT swapped at oauth2.googleapis.com, and the
 * calendar is plain REST.
 *
 * Keyless by default: the Workspace this was built for forbids service account
 * keys (iam.disableServiceAccountKeyCreation), so nothing secret is stored. On
 * Vercel the deployment's own OIDC token is exchanged at Google's STS through
 * a workload identity pool (only this project's deployments may use it), that
 * is swapped for the service account's token, and the service account signs
 * the delegation JWT with Google's managed key (iamcredentials signJwt). A JSON
 * key still works where one is allowed.
 *
 * Env:
 *   GOOGLE_BOOKING_SA_EMAIL  the service account, <name>@<project>.iam.gserviceaccount.com
 *   GOOGLE_WIF_PROVIDER      projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>
 *   GOOGLE_BOOKING_SA_KEY    or instead: the service account's JSON key, base64
 *   BOOKING_CALENDAR_OWNER   the Workspace user whose calendar holds bookings
 *   BOOKING_BUSY_CALENDARS   calendars whose events block a slot, comma
 *                            separated (default "primary", the owner's own)
 *   GOOGLE_SOURCE_ACCESS_TOKEN  local testing only: a token allowed to sign
 *                            as the service account (gcloud auth print-access-token)
 */
import { createSign } from "crypto";
import { TIME_ZONE } from "./config";

/** A Google API error that keeps the status, so callers can tell a 409 from a 500. */
export class CalendarError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/*
 * Google's own guidance for its APIs: retry 429, 5xx and its rate-limit 403s
 * with backoff, and a request that timed out or never connected. A 409 or a
 * 412 is an answer, never retried. Booking stays safe to retry because the
 * event id is the slot's (engine.ts): a repeated insert gets 409, and the
 * engine then finds its own booking already there.
 */
function rateLimited(e: unknown): boolean {
  return e instanceof CalendarError && (e.status === 429 || (e.status === 403 && /rateLimitExceeded|userRateLimitExceeded|quotaExceeded/i.test(e.message)));
}

function transient(e: unknown): boolean {
  if (rateLimited(e)) return true;
  if (e instanceof CalendarError) return [408, 500, 502, 503, 504].includes(e.status);
  const name = (e as { name?: string })?.name;
  return name === "AbortError" || name === "TimeoutError" || e instanceof TypeError;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/*
 * Two policies. A server error or timeout: three tries, 0.3 s then 0.9 s
 * apart. Google's per-calendar write limit (rateLimitExceeded, 429): what
 * Google asks for, exponential backoff with jitter, 0.5, 1, 2, 4 s and on,
 * up to six tries. Measured: about a hundred writes to one
 * calendar inside a minute trips it, which no real day comes near, but a
 * burst must slow down rather than turn customers away. Never past
 * `budgetMs` in all; the routes allow 60 s.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3, budgetMs = 20_000): Promise<T> {
  const started = Date.now();
  const base = Number(process.env.BOOKING_RETRY_BASE_MS) || 300;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const limited = rateLimited(e);
      const max = limited ? Math.max(attempts, 6) : attempts;
      const wait = limited
        ? Math.round(base * (5 / 3) * 2 ** (i - 1) * (0.5 + Math.random()))
        : base * 3 ** (i - 1) + Math.floor(Math.random() * (base * 0.66));
      if (i >= max || !transient(e) || Date.now() - started + wait > budgetMs) throw e;
      await sleep(wait);
    }
  }
}

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.freebusy",
].join(" ");
const API = "https://www.googleapis.com/calendar/v3";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

function readKey(): ServiceAccountKey | null {
  const raw = process.env.GOOGLE_BOOKING_SA_KEY;
  if (!raw) return null;
  try {
    const text = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    const key = JSON.parse(text) as ServiceAccountKey;
    return key.client_email && key.private_key ? key : null;
  } catch {
    return null;
  }
}

export function calendarOwner(): string | null {
  return process.env.BOOKING_CALENDAR_OWNER?.trim() || null;
}

const saEmail = () => process.env.GOOGLE_BOOKING_SA_EMAIL?.trim() || "";
const wifProvider = () => process.env.GOOGLE_WIF_PROVIDER?.trim() || "";

function keyless(): boolean {
  return !!saEmail() && (!!wifProvider() || !!process.env.GOOGLE_SOURCE_ACCESS_TOKEN);
}

export function googleCalendarConfigured(): boolean {
  return (!!readKey() || keyless()) && !!calendarOwner();
}

const b64url = (b: Buffer | string) =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

// One token per warm instance, refreshed a minute before Google's hour runs out.
let cached: { token: string; owner: string; exp: number } | null = null;

async function postJson<T>(url: string, body: unknown, bearer?: string): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new CalendarError(res.status, `${new URL(url).host}${new URL(url).pathname} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return (await res.json()) as T;
}

/** A Google token allowed to sign as the service account: the service account's own, reached from Vercel's OIDC token. */
async function signerToken(): Promise<string> {
  const local = process.env.GOOGLE_SOURCE_ACCESS_TOKEN?.trim();
  if (local) return local;
  const { getVercelOidcToken } = await import("@vercel/functions/oidc");
  const oidc = await getVercelOidcToken();
  const sts = await postJson<{ access_token: string }>("https://sts.googleapis.com/v1/token", {
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    audience: `//iam.googleapis.com/${wifProvider()}`,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    subject_token: oidc,
    subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
  });
  const sa = await postJson<{ accessToken: string }>(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail())}:generateAccessToken`,
    { scope: ["https://www.googleapis.com/auth/cloud-platform"], lifetime: "600s" },
    sts.access_token,
  );
  return sa.accessToken;
}

/** The delegation JWT, signed by a key file if there is one, otherwise by Google for the service account. */
async function delegationAssertion(owner: string, now: number, tokenUri: string): Promise<string> {
  const key = readKey();
  if (key) {
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const claims = b64url(JSON.stringify({ iss: key.client_email, sub: owner, scope: SCOPES, aud: tokenUri, iat: now, exp: now + 3600 }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    return `${header}.${claims}.${b64url(signer.sign(key.private_key))}`;
  }
  const signed = await postJson<{ signedJwt: string }>(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(saEmail())}:signJwt`,
    { payload: JSON.stringify({ iss: saEmail(), sub: owner, scope: SCOPES, aud: tokenUri, iat: now, exp: now + 3600 }) },
    await signerToken(),
  );
  return signed.signedJwt;
}

// Calls that arrive together while there is no token share one fetch.
let inflight: Promise<string> | null = null;

async function accessToken(): Promise<string> {
  const key = readKey();
  const owner = calendarOwner();
  if ((!key && !keyless()) || !owner) {
    throw new Error("Google Calendar is not configured (GOOGLE_BOOKING_SA_EMAIL + GOOGLE_WIF_PROVIDER, or GOOGLE_BOOKING_SA_KEY; and BOOKING_CALENDAR_OWNER)");
  }
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.owner === owner && cached.exp - 60 > now) return cached.token;
  if (!inflight) {
    inflight = withRetry(() => fetchToken(owner, key)).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function forgetToken() {
  cached = null;
}

async function fetchToken(owner: string, key: ServiceAccountKey | null): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = key?.token_uri || "https://oauth2.googleapis.com/token";
  const assertion = await delegationAssertion(owner, now, tokenUri);

  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    cache: "no-store",
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) {
    // unauthorized_client here means the Workspace admin has not yet allowed
    // this service account's client ID, or not for both scopes.
    throw new CalendarError(res.status, `Google token ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = { token: data.access_token, owner, exp: now + (data.expires_in || 3600) };
  return data.access_token;
}


async function callOnce<T>(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number }, refreshed = false): Promise<T> {
  const token = await accessToken();
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    cache: "no-store",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 6000),
  });
  if (res.status === 401 && !refreshed) {
    // A token Google has stopped honouring before its hour was up.
    forgetToken();
    return callOnce<T>(method, path, opts, true);
  }
  if (!res.ok) {
    throw new CalendarError(res.status, `Google Calendar ${method} ${path.split("?")[0]} ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

function call<T>(method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<T> {
  return withRetry(() => callOnce<T>(method, path, opts));
}

export interface CalendarEvent {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  etag?: string;
  summary?: string;
  description?: string;
  location?: string;
  /** "transparent" is Google's "Show as: Free": it blocks nothing. */
  transparency?: "opaque" | "transparent";
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  created?: string;
  updated?: string;
  extendedProperties?: { private?: Record<string, string> };
  /** The customer, as a guest: Google sends them the invitation, and the host's moves and cancels reach them, as Calendly's bookings did. */
  attendees?: { email: string; displayName?: string; organizer?: boolean; self?: boolean; responseStatus?: string }[];
  /** Google's event colour; "11" is the red Calendly gave every booking. */
  colorId?: string;
  guestsCanModify?: boolean;
  guestsCanInviteOthers?: boolean;
}

/*
 * A customer's booking has the customer as a guest, and Google emails a guest
 * about it: the invitation, a new time, a cancellation. That is how Calendly's
 * bookings reached customers, so every write of an event with a guest says
 * sendUpdates=all, and every other write (the lock events) stays silent.
 */
const updatesFor = (event: { attendees?: unknown[] }) => (event.attendees?.length ? "all" : "none");

export function busyCalendars(): string[] {
  const list = (process.env.BOOKING_BUSY_CALENDARS || "primary").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ["primary"];
}

/** Busy intervals across the blocking calendars, as epoch milliseconds. */
export async function busyBetween(timeMin: string, timeMax: string): Promise<{ start: number; end: number }[]> {
  const ids = busyCalendars();
  const data = await call<{ calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: { reason: string }[] }> }>(
    "POST",
    "/freeBusy",
    { body: { timeMin, timeMax, timeZone: TIME_ZONE, items: ids.map((id) => ({ id })) }, timeoutMs: 6000 },
  );
  const out: { start: number; end: number }[] = [];
  for (const id of ids) {
    const cal = data.calendars?.[id];
    // A calendar we cannot read must not quietly count as free.
    if (!cal || cal.errors?.length) throw new CalendarError(502, `freeBusy could not read calendar ${id}: ${cal?.errors?.map((e) => e.reason).join(", ") || "missing"}`);
    for (const b of cal.busy || []) out.push({ start: Date.parse(b.start), end: Date.parse(b.end) });
  }
  return out;
}

const enc = encodeURIComponent;

export function insertEvent(event: Omit<CalendarEvent, "etag">): Promise<CalendarEvent> {
  return call<CalendarEvent>("POST", `/calendars/primary/events?sendUpdates=${updatesFor(event)}`, { body: event });
}

/** Returns null for an id that has never existed. A deleted event comes back with status "cancelled". */
export async function getEvent(id: string): Promise<CalendarEvent | null> {
  try {
    return await call<CalendarEvent>("GET", `/calendars/primary/events/${enc(id)}`);
  } catch (e) {
    if (e instanceof CalendarError && (e.status === 404 || e.status === 410)) return null;
    throw e;
  }
}

/** Replaces the event, only if nobody has changed it since `etag` was read (412 otherwise). */
export function replaceEvent(event: CalendarEvent, etag: string): Promise<CalendarEvent> {
  return call<CalendarEvent>("PUT", `/calendars/primary/events/${enc(event.id)}?sendUpdates=${updatesFor(event)}`, {
    body: event,
    headers: { "If-Match": etag },
  });
}

export function patchEvent(id: string, patch: Partial<CalendarEvent>, etag?: string): Promise<CalendarEvent> {
  return call<CalendarEvent>("PATCH", `/calendars/primary/events/${enc(id)}?sendUpdates=${updatesFor(patch)}`, {
    body: patch,
    headers: etag ? { "If-Match": etag } : undefined,
  });
}

/** `tellGuests`: Google emails the event's guests that it is cancelled (a customer's booking). */
export async function deleteEvent(id: string, tellGuests = false): Promise<void> {
  try {
    await call<void>("DELETE", `/calendars/primary/events/${enc(id)}?sendUpdates=${tellGuests ? "all" : "none"}`);
  } catch (e) {
    if (e instanceof CalendarError && e.status === 410) return; // already gone
    throw e;
  }
}

/** Events on the owner's calendar between two instants, optionally only those carrying a private property. */
export async function listEvents(opts: { timeMin: string; timeMax: string; privateProperty?: string; showDeleted?: boolean }): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = [];
  let pageToken: string | undefined;
  do {
    const q = new URLSearchParams({ timeMin: opts.timeMin, timeMax: opts.timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
    if (opts.privateProperty) q.set("privateExtendedProperty", opts.privateProperty);
    if (opts.showDeleted) q.set("showDeleted", "true");
    if (pageToken) q.set("pageToken", pageToken);
    const page = await call<{ items?: CalendarEvent[]; nextPageToken?: string }>("GET", `/calendars/primary/events?${q}`);
    out.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** Events carrying a private property, wherever they are in time (for looking a booking up by its reference). */
export async function findByProperty(privateProperty: string, showDeleted = false): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({ privateExtendedProperty: privateProperty, singleEvents: "true", maxResults: "50" });
  if (showDeleted) q.set("showDeleted", "true");
  const page = await call<{ items?: CalendarEvent[] }>("GET", `/calendars/primary/events?${q}`);
  return page.items || [];
}

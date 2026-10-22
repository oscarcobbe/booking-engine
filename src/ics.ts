/**
 * The calendar file attached to booking emails, so the customer can add the
 * visit to their own calendar the way Calendly's invite let them.
 *
 * METHOD:PUBLISH rather than REQUEST: the file adds an event, it does not ask
 * the customer to accept an invitation whose reply would go nowhere. The UID
 * is the booking reference, so a moved booking replaces the earlier entry
 * (higher SEQUENCE) and a cancellation removes it.
 */
const stamp = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const text = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

/** Lines longer than 75 octets are folded, as RFC 5545 asks. */
function fold(line: string): string {
  const out: string[] = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = " " + rest.slice(cut);
  }
  out.push(rest);
  return out.join("\r\n");
}

export function bookingIcs(d: {
  ref: string;
  domain: string;
  title: string;
  start: string;
  end: string;
  location: string;
  description: string;
  organizerName: string;
  organizerEmail: string;
  sequence?: number;
  cancelled?: boolean;
}): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${d.domain}//Bookings//EN`,
    "CALSCALE:GREGORIAN",
    `METHOD:${d.cancelled ? "CANCEL" : "PUBLISH"}`,
    "BEGIN:VEVENT",
    `UID:${d.ref}@${d.domain}`,
    `SEQUENCE:${d.sequence ?? 0}`,
    `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(d.start)}`,
    `DTEND:${stamp(d.end)}`,
    `SUMMARY:${text(d.title)}`,
    `LOCATION:${text(d.location)}`,
    `DESCRIPTION:${text(d.description)}`,
    `ORGANIZER;CN=${text(d.organizerName)}:mailto:${d.organizerEmail}`,
    `STATUS:${d.cancelled ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}

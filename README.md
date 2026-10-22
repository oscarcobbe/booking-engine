# booking-engine

Customers book visits on a website, and the bookings go straight into one person's Google Calendar. No booking service sits in between, and there is no database: the calendar event is the booking.

I built it in October 2026 to replace Calendly for two small businesses. Both websites book the same installer, so a slot taken on one site must be gone on the other at that moment. It has been live since 20 October 2026. Before switching it on, I tested it on the real calendar: three customers booked one slot at the same moment, one got it and the other two were told it was taken.

This repository is the engine and its tests. The two websites, their emails and the CRM that reads these bookings are client code and stay private. The business details in [`src/config.ts`](src/config.ts) and in the tests are made up.

## What it guarantees

- **A slot is offered only when the host is free.** Before offering or booking a slot, the engine asks Google's free/busy API about every blocking calendar. A calendar Google cannot read throws an error. It never counts as free.
- **Two customers can never hold the same slot.** The Google event id is derived from the slot itself (`bks` + date + time + a generation digit). Two sites racing for 10:00 on a Tuesday both try to write the same id, and Google refuses the second write with `409`. No lock server or database is needed.
- **A cancelled slot can be booked again.** Google keeps a deleted event's id. The engine takes the cancelled event back with a conditional write (`If-Match` on its ETag), so if two people try at once, only one succeeds.
- **When the host drags a booking elsewhere**, its old slot opens up. The next booking for that slot uses the next generation of the id.
- **Moves and cancels happen one at a time per booking.** A move is two writes: book the new slot, then release the old one. So each booking gets a short lock, which is also a calendar event with an id derived from the booking reference. A lock left behind by a crashed function is taken over after a minute.
- **A lost answer is never a double booking.** Google can write an event and then time out before replying. Any unclear result is settled by reading the slot's event before replying to the customer. A payment webhook delivered twice gives one booking, not two.
- **Google failing is waited out within limits.** Server errors and timeouts get 3 tries with backoff. Google's per-calendar write limit (about a hundred writes a minute) gets exponential backoff with jitter, up to 6 tries. Everything stays within a 20-second budget.
- **Customers manage their own booking.** Reschedule and cancel links carry an HMAC of the booking reference, so a link works only for the booking it was sent for. Moving a booking keeps its reference, so links already emailed keep working.
- **It looks like Calendly to everyone involved.** Events are written the way Calendly wrote them: same title, colour, description and answers. The customer is a guest on the event, so Google sends the invitation, and a move or cancel by the host reaches them too. Bookings Calendly made before the switch are read back from the calendar, so reminders and the diary still find them.

## Google access without a key

The Workspace this was built for forbids service account keys. On Vercel, the engine swaps the deployment's own OIDC token for a Google access token through workload identity federation. The service account then signs the domain-wide-delegation JWT with Google's managed key, so no secret is stored anywhere. A JSON key still works where one is allowed. The calendar is plain REST over `fetch`, with no Google SDK.

| Variable | |
|---|---|
| `BOOKING_CALENDAR_OWNER` | the Workspace user whose calendar holds the bookings |
| `GOOGLE_BOOKING_SA_EMAIL`, `GOOGLE_WIF_PROVIDER` | keyless sign-in: the service account and the workload identity provider |
| `GOOGLE_BOOKING_SA_KEY` | or instead: the service account's JSON key, base64 |
| `BOOKING_BUSY_CALENDARS` | calendars whose events block a slot (default `primary`) |
| `BOOKING_LINK_SECRET` | 16+ random characters, for the customer links |

The service account needs domain-wide delegation for `calendar.events` and `calendar.freebusy`.

## Using it

```ts
import { book, cancel, freeStarts, manageUrl, reschedule } from "./src/engine";

await freeStarts("2026-11-03");            // ["10:00", "15:00"]

const r = await book({
  site: "security", kind: "installation",
  date: "2026-11-03", start: "10:00",
  name: "Ada Lovelace", email: "ada@example.com",
});
if (!r.ok) {
  // r.reason is "taken" (offer the next free slot), "invalid" or "error"
} else {
  manageUrl(r.booking, "reschedule");      // the link for the confirmation email
  await reschedule(r.booking.ref, "2026-11-04", "12:30");
  await cancel(r.booking.ref);
}
```

Slots, opening days, notice, the host's name and each site's visits are in [`src/config.ts`](src/config.ts).

## Tests

```bash
npm install
npm test
```

[`test/engine.test.mjs`](test/engine.test.mjs) runs the engine against a fake Google Calendar that follows Google's rules: `409` on a taken id, ETags, cancelled events keeping their id, and which guests get emailed for each change. The fake can inject faults: outages, timeouts, rate limits, an expired token, and answers lost after the write. It runs 87 checks, including:

- two bookings racing past the free/busy check at the same moment;
- 25 customers booking one slot at the same instant (exactly one gets it);
- pairs racing for 15 slots while Google drops answers (never two in a slot);
- the clock change at the end of October;
- six moves of one booking at once, and a move racing a cancel;
- a lock left by a crashed function;
- what each customer hears from Google, end to end.

When I change the engine, I run the suite many times: one ordering bug only showed up in 4 runs out of 8.

## How it was built

I built this with Claude Code. I set the requirements, decided how it should behave when Google fails, reviewed the work, and ran the live tests and the switch-over from Calendly.

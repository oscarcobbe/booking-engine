/**
 * Everything particular to one business. The engine reads these and knows
 * nothing else about who is booked or why.
 *
 * The values are a made-up example shaped like the real setup: one person
 * does the visits, two websites sell different services, and both book into
 * that person's Google Calendar.
 */

/** Slots are wall-clock times in this zone, and survive its clock changes. */
export const TIME_ZONE = "Europe/Dublin";

/** Start times (HH:MM, local) and the length of every visit. */
export const SLOT_STARTS = ["10:00", "12:30", "15:00"] as const;
export const SLOT_MINUTES = 120;

/** Monday to Friday (Date.getUTCDay of the local date). Each site can narrow this in its own date picker. */
export const WORKING_DAYS = [1, 2, 3, 4, 5];

/** The least notice a booking needs. The sites ask for days; this only guards a crafted request. */
export const MIN_NOTICE_MS = 4 * 3600_000;

/** Whose calendar it is. Every booking is titled "<customer> and <HOST_NAME>", as Calendly titled them. */
export const HOST_NAME = "Pat";

export type BookingKind = "consultation" | "installation";

interface Visit {
  /** The visit's name as the host sees it in their calendar. */
  title: string;
  description: string;
}

export interface Site {
  /** Where this site's customers reschedule or cancel: `<manageBase>/booking/<ref>`. */
  manageBase: string;
  visits: Record<BookingKind, Visit>;
}

export const SITES = {
  security: {
    manageBase: "https://security.example.com",
    visits: {
      consultation: {
        title: "Example Security - Home Consultation",
        description: "A free visit to look at the house, suggest where each device should go and leave a written quote.",
      },
      installation: {
        title: "Example Security - Installation",
        description: "We fit the devices, set up the Wi-Fi and the app, and show you how it all works. Allow 2 hours.",
      },
    },
  },
  care: {
    manageBase: "https://care.example.com",
    visits: {
      consultation: {
        title: "Example Care - Home Consultation",
        description: "A free visit to see what would help at home and recommend a setup. No obligation.",
      },
      installation: {
        title: "Example Care - Installation",
        description: "We fit the agreed setup and show everyone how it works before we leave. Allow up to 2 hours.",
      },
    },
  },
} satisfies Record<string, Site>;

export type BookingSite = keyof typeof SITES;

/** The site an event is filed under when it does not say. */
export const DEFAULT_SITE: BookingSite = "security";

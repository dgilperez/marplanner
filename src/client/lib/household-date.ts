import { useEffect, useState } from "react";

import { nextOccurrenceInTz } from "../../shared/householdTime";

/** Returns the household's current business date. Callers obtain the IANA timezone from the
 * shared `useHouseholdSettings` context — MealsManagement is the one remaining
 * exception, still reading it via its own ad-hoc `/api/settings` GET (it has a user-facing
 * retry affordance the shared, non-retrying context can't support) — after the admin surface
 * has been unlocked.
 */
export function todayInHouseholdTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

/** Formats a household calendar date (`YYYY-MM-DD`). The date is read at UTC noon and formatted
 * in UTC, so it never shifts to the neighbouring day in the viewer's time zone. */
export function formatCalendarDate(
  date: string,
  locale: string,
  options: Intl.DateTimeFormatOptions
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`)
  );
}

/** Calls `wake` after `delayMs` and on every visibility change, which is how a tablet that slept
 * through a throttled timer catches up. Returns the cleanup. No polling. */
export function wakeAfter(delayMs: number, wake: () => void): () => void {
  const timer = setTimeout(wake, delayMs);
  document.addEventListener("visibilitychange", wake);
  return () => {
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", wake);
  };
}

/** The household's current date, read again at household midnight and when the tablet wakes, so
 * a page left open does not keep yesterday's date. Null until the timezone is known. */
export function useHouseholdToday(timezone: string | null | undefined): string | null {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!timezone) return;
    return wakeAfter(nextOccurrenceInTz("00:00", timezone, now) - Date.now(), () =>
      setNow(Date.now())
    );
  }, [timezone, now]);
  return timezone ? todayInHouseholdTimezone(timezone) : null;
}

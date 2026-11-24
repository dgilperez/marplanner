// Repeat rules of household to-dos (ADR-068): pure calendar-date math shared by the server, the
// client and the client tests' in-memory API. Dates are `YYYY-MM-DD` strings handled as UTC
// calendar days, so no step depends on the timezone or the clock changes of the machine.

export const TODO_REPEAT_UNITS = ["day", "week", "month", "year"] as const;
export type TodoRepeatUnit = (typeof TODO_REPEAT_UNITS)[number];

export const TODO_REPEAT_EVERY_MIN = 1;
export const TODO_REPEAT_EVERY_MAX = 99;

/** TodoRepeat — "every `every` `unit`s", counted from the to-do's due date. */
export interface TodoRepeat {
  every: number;
  unit: TodoRepeatUnit;
}

const DAY_MS = 86_400_000;
const LAST_YEAR = 9999;
const DAYS_PER_STEP = { day: 1, week: 7 } as const;
const MONTHS_PER_STEP = { month: 1, year: 12 } as const;

/** True when `value` is exactly `{ every, unit }` with a whole interval in range and a known unit. */
export function isTodoRepeat(value: unknown): value is TodoRepeat {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { every, unit, ...rest } = value as Record<string, unknown>;
  return (
    Object.keys(rest).length === 0 &&
    Number.isInteger(every) &&
    (every as number) >= TODO_REPEAT_EVERY_MIN &&
    (every as number) <= TODO_REPEAT_EVERY_MAX &&
    TODO_REPEAT_UNITS.includes(unit as TodoRepeatUnit)
  );
}

export function sameTodoRepeat(a: TodoRepeat | null, b: TodoRepeat | null): boolean {
  return a?.every === b?.every && a?.unit === b?.unit;
}

/** The day of the month a month or year rule returns to after a shorter month clamped it. */
export function repeatAnchorDay(dueDate: string): number {
  return Number(dueDate.slice(8));
}

function calendarDate(year: number, monthIndex: number, day: number): string | null {
  if (year > LAST_YEAR) return null;
  return [
    String(year).padStart(4, "0"),
    String(monthIndex + 1).padStart(2, "0"),
    String(day).padStart(2, "0"),
  ].join("-");
}

const parts = (date: string) => date.split("-").map(Number) as [number, number, number];

/** The UTC midnight of a calendar day. `Date.UTC` reads the years 0 to 99 as 1900 to 1999, so
 * the year is set separately. Day 0 is the last day of the month before. */
function utcMidnight(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

function utcDay(date: string): number {
  const [year, month, day] = parts(date);
  return utcMidnight(year, month - 1, day).getTime();
}

/** `dueDate` advanced by `steps` intervals. A month or year step lands on `anchorDay`, or on the
 * last day of a month that is shorter. Null past the year 9999, where `YYYY-MM-DD` ends. */
function occurrence(
  dueDate: string,
  repeat: TodoRepeat,
  anchorDay: number,
  steps: number
): string | null {
  if (repeat.unit === "day" || repeat.unit === "week") {
    const shifted = new Date(
      utcDay(dueDate) + steps * repeat.every * DAYS_PER_STEP[repeat.unit] * DAY_MS
    );
    return calendarDate(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  }
  const [year, month] = parts(dueDate);
  const months = year * 12 + (month - 1) + steps * repeat.every * MONTHS_PER_STEP[repeat.unit];
  const nextYear = Math.floor(months / 12);
  const nextMonthIndex = months % 12;
  const lastDay = utcMidnight(nextYear, nextMonthIndex + 1, 0).getUTCDate();
  return calendarDate(nextYear, nextMonthIndex, Math.min(anchorDay, lastDay));
}

/** A step count no later than the first one that lands after `today`, so a due date centuries
 * back costs a couple of steps and not one per interval since then. Every earlier step lands on
 * or before `today`: in days it is at most the days elapsed, in months it stays in an earlier
 * month. */
function firstStep(dueDate: string, repeat: TodoRepeat, today: string): number {
  const [year, month] = parts(dueDate);
  const [thisYear, thisMonth] = parts(today);
  const elapsed =
    repeat.unit === "day" || repeat.unit === "week"
      ? (utcDay(today) - utcDay(dueDate)) / DAY_MS / DAYS_PER_STEP[repeat.unit]
      : ((thisYear - year) * 12 + thisMonth - month) / MONTHS_PER_STEP[repeat.unit];
  return Math.max(1, Math.floor(elapsed / repeat.every));
}

/** The due date of the occurrence that follows a completed repeating to-do: `dueDate` advanced by
 * whole intervals until it is strictly after `today`, so a to-do finished several cycles late
 * yields one next date and not a run of overdue ones. `anchorDay` is the day of the month the
 * rule was set on (`repeatAnchorDay`). Null when no such date exists before the year 10000.
 */
export function nextRepeatDueDate(
  dueDate: string,
  repeat: TodoRepeat,
  anchorDay: number,
  today: string
): string | null {
  for (let steps = firstStep(dueDate, repeat, today); ; steps++) {
    const next = occurrence(dueDate, repeat, anchorDay, steps);
    if (next === null || next > today) return next;
  }
}

import { describe, expect, it } from "vitest";

import {
  TODO_REPEAT_EVERY_MAX,
  isTodoRepeat,
  nextRepeatDueDate,
  repeatAnchorDay,
  sameTodoRepeat,
  type TodoRepeat,
} from "../../src/shared";

const every = (count: number, unit: TodoRepeat["unit"]): TodoRepeat => ({ every: count, unit });

/** The next due date of a to-do whose anchor is its own due day. */
const next = (dueDate: string, repeat: TodoRepeat, today: string) =>
  nextRepeatDueDate(dueDate, repeat, repeatAnchorDay(dueDate), today);

describe("isTodoRepeat", () => {
  it.each([
    ["every day", every(1, "day")],
    ["every 2 weeks", every(2, "week")],
    ["every 6 months", every(6, "month")],
    ["the longest interval", every(TODO_REPEAT_EVERY_MAX, "year")],
  ])("accepts %s", (_label, value) => {
    expect(isTodoRepeat(value)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "weekly"],
    ["an array", [1, "day"]],
    ["a missing unit", { every: 1 }],
    ["a missing interval", { unit: "day" }],
    ["an unknown unit", { every: 1, unit: "hour" }],
    ["a zero interval", every(0, "day")],
    ["a negative interval", every(-1, "day")],
    ["an interval over the cap", every(TODO_REPEAT_EVERY_MAX + 1, "day")],
    ["a fractional interval", every(1.5, "week")],
    ["a numeric string interval", { every: "2", unit: "week" }],
    ["an extra field", { every: 1, unit: "day", until: "2027-01-01" }],
  ])("rejects %s", (_label, value) => {
    expect(isTodoRepeat(value)).toBe(false);
  });
});

describe("sameTodoRepeat", () => {
  it("compares rules by interval and unit, and no rule only with no rule", () => {
    expect(sameTodoRepeat(null, null)).toBe(true);
    expect(sameTodoRepeat(every(2, "week"), every(2, "week"))).toBe(true);
    expect(sameTodoRepeat(every(2, "week"), every(3, "week"))).toBe(false);
    expect(sameTodoRepeat(every(2, "week"), every(2, "month"))).toBe(false);
    expect(sameTodoRepeat(every(2, "week"), null)).toBe(false);
    expect(sameTodoRepeat(null, every(2, "week"))).toBe(false);
  });
});

describe("nextRepeatDueDate", () => {
  it.each([
    ["1 day", "2026-03-10", every(1, "day"), "2026-03-11"],
    ["10 days across a month end", "2026-01-25", every(10, "day"), "2026-02-04"],
    ["1 day across a year end", "2026-12-31", every(1, "day"), "2027-01-01"],
    ["1 day into a leap day", "2028-02-28", every(1, "day"), "2028-02-29"],
    ["2 weeks", "2026-03-10", every(2, "week"), "2026-03-24"],
    ["1 week across the day clocks change", "2026-03-25", every(1, "week"), "2026-04-01"],
    ["1 month", "2026-03-10", every(1, "month"), "2026-04-10"],
    ["3 months across a year end", "2026-11-15", every(3, "month"), "2027-02-15"],
    ["1 year", "2026-03-10", every(1, "year"), "2027-03-10"],
    ["5 years", "2026-03-10", every(5, "year"), "2031-03-10"],
  ])("advances a to-do completed on its due date by %s", (_label, dueDate, repeat, expected) => {
    expect(next(dueDate, repeat, dueDate)).toBe(expected);
  });

  it("clamps a month step to the last day of a shorter month", () => {
    expect(next("2026-01-31", every(1, "month"), "2026-01-31")).toBe("2026-02-28");
    expect(next("2028-01-31", every(1, "month"), "2028-01-31")).toBe("2028-02-29");
    expect(next("2026-03-31", every(1, "month"), "2026-03-31")).toBe("2026-04-30");
    expect(next("2026-08-31", every(6, "month"), "2026-08-31")).toBe("2027-02-28");
  });

  it("keeps the original day of the month after a clamped step: 31 Jan, 28 Feb, 31 Mar", () => {
    const repeat = every(1, "month");
    const february = nextRepeatDueDate("2026-01-31", repeat, 31, "2026-01-31");
    expect(february).toBe("2026-02-28");
    expect(nextRepeatDueDate("2026-02-28", repeat, 31, "2026-02-28")).toBe("2026-03-31");
    expect(nextRepeatDueDate("2026-03-31", repeat, 31, "2026-03-31")).toBe("2026-04-30");
    // Without the anchor the 28th would stick.
    expect(nextRepeatDueDate("2026-02-28", repeat, 28, "2026-02-28")).toBe("2026-03-28");
  });

  it("moves a 29 February yearly to-do to 28 February and back to the 29th in a leap year", () => {
    const repeat = every(1, "year");
    expect(nextRepeatDueDate("2024-02-29", repeat, 29, "2024-02-29")).toBe("2025-02-28");
    expect(nextRepeatDueDate("2027-02-28", repeat, 29, "2027-02-28")).toBe("2028-02-29");
    expect(nextRepeatDueDate("2024-02-29", every(4, "year"), 29, "2024-02-29")).toBe("2028-02-29");
  });

  it("treats 2100 as a common year and 2000 as a leap year", () => {
    expect(next("2100-01-31", every(1, "month"), "2100-01-31")).toBe("2100-02-28");
    expect(next("2000-01-31", every(1, "month"), "2000-01-31")).toBe("2000-02-29");
  });

  it("returns a date strictly after today when the to-do is finished late", () => {
    // Three weekly cycles late: one next occurrence, the first after today.
    expect(next("2026-03-02", every(1, "week"), "2026-03-24")).toBe("2026-03-30");
    expect(next("2026-01-10", every(1, "month"), "2026-04-22")).toBe("2026-05-10");
    expect(next("2020-06-01", every(1, "year"), "2026-11-24")).toBe("2027-06-01");
    expect(next("2026-03-01", every(3, "day"), "2026-03-11")).toBe("2026-03-13");
  });

  it("skips an occurrence that falls on today: the next one is after today", () => {
    expect(next("2026-03-03", every(1, "week"), "2026-03-10")).toBe("2026-03-17");
    expect(next("2026-02-10", every(1, "month"), "2026-03-10")).toBe("2026-04-10");
  });

  it("stays on the cycle of the due date when catching up, and keeps the anchor", () => {
    // 31 Jan monthly, finished in June: 30 Jun is not after 30 Jun, so 31 Jul.
    expect(next("2026-01-31", every(1, "month"), "2026-06-30")).toBe("2026-07-31");
    expect(next("2026-01-31", every(1, "month"), "2026-06-29")).toBe("2026-06-30");
  });

  it("advances one interval when the to-do is finished before its due date", () => {
    expect(next("2026-12-10", every(1, "month"), "2026-11-24")).toBe("2027-01-10");
    expect(next("2026-12-10", every(2, "week"), "2026-11-24")).toBe("2026-12-24");
  });

  it("catches up from a due date centuries back to the same cycle", () => {
    // 2026-11-24 is 703,784 days after 0100-01-01, so the daily cycle lands on every date.
    expect(next("0100-01-01", every(1, "day"), "2026-11-24")).toBe("2026-11-25");
    // 703,784 = 7 * 100,540 + 4: the weekly cycle last landed four days before today.
    expect(next("0100-01-01", every(1, "week"), "2026-11-24")).toBe("2026-11-27");
    expect(next("0100-01-31", every(1, "month"), "2026-11-24")).toBe("2026-11-30");
    expect(next("0100-01-31", every(7, "month"), "2026-11-30")).toBe("2027-05-31");
    expect(next("0104-02-29", every(3, "year"), "2026-11-24")).toBe("2027-02-28");
  });

  it("has no next date once the calendar's four-digit years run out", () => {
    expect(next("9999-06-01", every(1, "year"), "2026-11-24")).toBeNull();
    expect(next("9999-12-31", every(1, "day"), "2026-11-24")).toBeNull();
    expect(next("9990-06-01", every(9, "year"), "2026-11-24")).toBe("9999-06-01");
  });
});

describe("repeatAnchorDay", () => {
  it("is the day of the month of the due date", () => {
    expect(repeatAnchorDay("2026-01-31")).toBe(31);
    expect(repeatAnchorDay("2026-02-05")).toBe(5);
  });
});

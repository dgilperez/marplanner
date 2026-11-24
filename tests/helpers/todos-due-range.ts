/** The due-date range filters of `GET /api/todos`, as cases that the real API
 * (`tests/boundary/todos-due-range.test.ts`) and the in-memory API of the client tests
 * (`tests/client/todos-fake-backend.test.ts`) both have to answer the same way. */
export const DUE_RANGE_SEEDS = [
  { title: "undated", dueDate: null, done: false },
  { title: "sep-18", dueDate: "2026-09-18", done: false },
  { title: "sep-21", dueDate: "2026-09-21", done: false },
  { title: "sep-22", dueDate: "2026-09-22", done: false },
  { title: "sep-27", dueDate: "2026-09-27", done: false },
  { title: "sep-28", dueDate: "2026-09-28", done: false },
  { title: "done-sep-22", dueDate: "2026-09-22", done: true },
] as const;

/** `[label, query string, titles expected in order]`. */
export const DUE_RANGE_CASES: readonly (readonly [string, string, readonly string[]])[] = [
  [
    "dueFrom keeps to-dos due on or after the date and drops undated ones",
    "?dueFrom=2026-09-22",
    ["sep-22", "sep-27", "sep-28"],
  ],
  [
    "dueFrom and dueBy bound a range, both ends included",
    "?dueFrom=2026-09-21&dueBy=2026-09-27",
    ["sep-21", "sep-22", "sep-27"],
  ],
  ["a one-day range keeps that day", "?dueFrom=2026-09-22&dueBy=2026-09-22", ["sep-22"]],
  ["a range that ends before it starts is empty", "?dueFrom=2026-09-27&dueBy=2026-09-21", []],
  [
    "the range combines with status",
    "?status=all&dueFrom=2026-09-22&dueBy=2026-09-27",
    ["sep-22", "sep-27", "done-sep-22"],
  ],
  ["dueBy alone still includes every earlier date", "?dueBy=2026-09-21", ["sep-18", "sep-21"]],
];

/** `[label, query string]` of requests both must refuse with 400 `validation_error`. */
export const DUE_RANGE_REFUSALS: readonly (readonly [string, string])[] = [
  ["a loosely formatted dueFrom", "?dueFrom=2026-9-22"],
  ["an impossible dueFrom", "?dueFrom=2026-02-30"],
  ["an empty dueFrom", "?dueFrom="],
  ["a repeated dueFrom", "?dueFrom=2026-09-21&dueFrom=2026-09-22"],
];

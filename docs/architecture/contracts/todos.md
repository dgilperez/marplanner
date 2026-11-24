# To-dos Domain Contract

Status: maintained contract
Depends on decisions: `ADR-001`, `ADR-002`, `ADR-003`, `ADR-005`, `ADR-006`, `ADR-039`, `ADR-054`, `ADR-068`

## Purpose

To-dos for the adults of the household: things to get done, grouped in lists, with an optional
due date, an optional adult assignee and an optional repeat rule for the ones that come back, such
as an insurance renewal or a filter change. They are separate from routines and chores, which
belong to the children.

Delivered: the server module, the HTTP API, the Plugin Management entry, the kiosk page `/todos`
and a group in the Home agenda. To-dos are not shown in the full Calendar page (`/calendar`).

## Vocabulary

- **List**: a named group of to-dos. Every to-do belongs to exactly one list.
- **To-do**: a title with optional notes, due date and assignee. It is **done** while
  `completedAt` is set and **open** otherwise.
- **Assignee**: the adult responsible for a to-do, stored as a member id.
- **Repeat rule**: `{ every, unit }`, read as "every `every` `unit`s", with `every` from 1 to 99
  and `unit` one of `day`, `week`, `month`, `year`. It counts from the to-do's due date.
- **Next occurrence**: the open to-do the server creates when a repeating to-do is completed.
- **Anchor day**: the day of the month a month or year rule returns to. It is stored with the rule
  and no read returns it.

## Invariants

1. **TODOS-INV-01** A list name is trimmed, non-blank and at most 80 characters after trimming.
   A name with no visible character (only white space, zero-width or format characters) is blank.
   No two lists share a name; names are compared exactly, so `Home` and `home` are different.
2. **TODOS-INV-02** A to-do belongs to exactly one existing list. Deleting a list deletes its
   to-dos.
3. **TODOS-INV-03** A title is trimmed, non-blank by the rule of TODOS-INV-01 and at most 200
   characters after trimming.
   Notes are at most 2000 characters and are stored as written; blank notes are stored as null.
4. **TODOS-INV-04** A due date is a strict calendar-valid `YYYY-MM-DD` (`ADR-006`) or null.
5. **TODOS-INV-05** A write that sets or changes the assignee requires an active member whose
   role is `parent`. A write that leaves the assignee as stored does not re-check it.
6. **TODOS-INV-06** `assignee_member_id` is a soft reference with no foreign key to `members`
   (`ADR-039` §3, `ADR-054`). Reads return the stored id even when that member is archived or
   missing.
7. **TODOS-INV-07** Completing is idempotent and keeps the first `completedAt`. Reopening is
   idempotent and clears it. The edit command never changes completion.
8. **TODOS-INV-08** Write bodies are allow-listed: a non-object body or an unsupported field is
   rejected and nothing is written. In an edit, `null` clears a nullable field and an omitted
   field keeps its value; an edit names at least one field.
9. **TODOS-INV-09** Timestamps are integer epoch milliseconds (`ADR-003`). `updatedAt` moves
   forward on every change, also when two changes land in the same millisecond.
10. **TODOS-INV-10** The module reaches the host only through `src/server/host-api` and touches
    only its own tables (`ADR-039` Rule B).
11. **TODOS-INV-11** A repeat rule is null or exactly `{ every, unit }` with a whole `every` from
    1 to 99 and a known `unit`. A to-do with a rule has a due date: a write that would leave a
    rule without one is rejected, so clearing the due date of a repeating to-do needs
    `repeat: null` in the same request.
12. **TODOS-INV-12** Completing an open repeating to-do creates its next occurrence in the same
    transaction as the completion. A to-do creates at most one next occurrence in its life: the
    created id is recorded on it, so a second completion, a completion after a reopen and a
    completion after that occurrence was deleted create nothing.
13. **TODOS-INV-13** The next due date is the completed to-do's due date advanced by whole
    intervals until it is strictly after the household's current date (`ADR-005`). A month or year
    step lands on the anchor day, or on the last day of a month that is shorter. The anchor day is
    the day of the month of the due date when the rule was set; a write that changes the due date
    or the rule sets it again, and a next occurrence inherits it.

## Behaviors

- **List the lists**: ordered by name without regard to ASCII case, each with `openCount`, the
  number of its to-dos that are not done. Only ASCII letters fold, so a name that starts with an
  accented letter comes after every ASCII one; a client that shows the lists orders them itself.
- **Create, rename, delete a list**: a duplicate name is a conflict. Deleting an unknown list is
  not-found.
- **List to-dos**: filters combine. `status` is `open` (default), `done` or `all`. `dueBy` keeps
  to-dos whose due date is on or before the given date, so it includes overdue ones and drops
  undated ones. `listId` and `assigneeMemberId` match the stored ids; an id nobody holds matches
  nothing. Order: open before done, then due date ascending with undated last, then creation
  order.
- **Create, read, edit, delete a to-do**: an unknown to-do is not-found. An edit may move the
  to-do to another list.
- **Complete**: returns the done to-do with one more field, `nextOccurrence`, which holds the
  to-do this completion created or null. The next occurrence is open and copies the list, title,
  notes and rule. It copies the assignee only while that member is still an active parent and is
  unassigned otherwise; the completion never fails because of the assignee. A due date whose next
  step would pass the year 9999 has no next occurrence.
- **Reopen**: returns the to-do. It does not delete the occurrence the completion created, so a
  reopened repeating to-do and its next occurrence are both open. The done to-do keeps its rule as
  a record.

## Interfaces

All routes require the device credential. While the plugin is inactive the lifecycle gate answers
503 with `{ "code": "plugin_unavailable", "message" }`: the code is in `code`, not in `error`,
because the gate answers before any to-dos route runs. Schemas: OpenAPI tag `todos` in [the API reference](../../api/README.md).

| Method and path                     | Result                                              |
| ----------------------------------- | --------------------------------------------------- |
| `GET /api/todos/lists`              | 200 `TodoList[]`                                    |
| `POST /api/todos/lists`             | 201 `TodoList`; 400; 409 `duplicate_name`           |
| `PATCH /api/todos/lists/{id}`       | 200 `TodoList`; 400; 404; 409 `duplicate_name`      |
| `DELETE /api/todos/lists/{id}`      | 204; 404                                            |
| `GET /api/todos`                    | 200 `Todo[]`; 400 on an invalid `status` or `dueBy` |
| `POST /api/todos`                   | 201 `Todo`; 400                                     |
| `GET /api/todos/{id}`               | 200 `Todo`; 404                                     |
| `PATCH /api/todos/{id}`             | 200 `Todo`; 400; 404                                |
| `DELETE /api/todos/{id}`            | 204; 404                                            |
| `POST /api/todos/{id}/completion`   | 200 `TodoCompletion`; 404                           |
| `DELETE /api/todos/{id}/completion` | 200 `Todo`; 404                                     |

Validation failures use `{ "error": "validation_error", "message" }`, including an unknown
`listId` or a rejected assignee in a body.

### Client surfaces

| Surface           | Where                                                               | Gated by                           |
| ----------------- | ------------------------------------------------------------------- | ---------------------------------- |
| Kiosk page        | family route `todos` at `/todos`, `src/client/todos/TodosBoard.tsx` | route contribution `todos-api`     |
| Navigation entry  | `shell.nav.todos` in the household chrome                           | plugin state                       |
| Home agenda group | `src/client/todos/AgendaTodos.tsx`, hosted by `TodayAgenda`         | widget contribution `agenda-todos` |

- The page writes without the admin PIN, as the Calendar page does for local events, with one
  exception: deleting a list asks for the admin PIN first, with the admin gate's PIN pad, and then
  for the confirmation. The PIN covers that one deletion and does not unlock the admin area; an
  already unlocked admin session skips it. This is a gate of the kiosk UI only: the PIN never
  authorizes a backend request, and `DELETE /api/todos/lists/{id}` accepts the call from any
  provisioned device.
- The deletion confirmation says how many to-dos go with the list and cannot be accepted until
  that number is read or its read has failed.
- The page shows the lists ordered by name with a collator for the UI language, and selects the
  first of them when nothing is selected.
- The page marks overdue to-dos against the household date, which it reads again at household
  midnight and when the tablet becomes visible.
- The assignee picker offers `GET /api/members?lifecycle=all` filtered to active parents. The
  stored assignee of the to-do being edited stays in the picker when it no longer qualifies, and
  an edit sends `assigneeMemberId` only when the selection changed.
- The agenda group reads `GET /api/todos?status=open&dueBy=<household date>` and orders the answer
  as today's to-dos, then overdue ones. `TodayAgenda` passes it the household date and its Members
  read, and the group reports back whether it occupies room; the agenda uses that to decide whether
  to show its empty message; while the plugin catalog is still loading the agenda shows no empty
  message either. `TodayAgenda` holds no to-do data.
- The client picks its copy from the stable code of a failed response and never shows the
  server's `message`. It reads the code from `error` (`duplicate_name`) and, when a gate answered
  instead of a route, from `code` (`plugin_unavailable`).
- A quick add in flight disables its button, and a checkbox is disabled while its completion
  request is in flight, so a second tap sends nothing.
- The to-do form has a "Repeats" select (never, days, weeks, months, years) that is disabled until
  a due date is set, and an "Every" number from 1 to 99 once a unit is chosen. Taking the due date
  away again sends no rule, and on an edit clears the stored one in the same request.
- A row of a repeating to-do carries an icon whose accessible name says how often it repeats, with
  its own singular wording ("Repeats every week", "Se repite cada semana").
- The page and the agenda group read again after a completion, which is how the next occurrence
  reaches the screen. It is due after today, so the agenda lists it on its own date.

## Events

Emits none; subscribes to none.

## Data / Setup Contract

Owned tables, created by `drizzle/0003_todos.sql`:

- `todo_lists` (`id`, `name` unique, `created_at`, `updated_at`).
- `todo_items` (`id`, `list_id` → `todo_lists.id` ON DELETE CASCADE, `title`, `notes`,
  `due_date`, `assignee_member_id`, `completed_at`, `created_at`, `updated_at`, `repeat_every`,
  `repeat_unit`, `repeat_anchor_day`, `next_todo_id`), indexed on `list_id` and `due_date`.
  `drizzle/0004_todo_repeat.sql` adds the last four columns by rebuilding the table and keeps
  every stored to-do, without a rule. One CHECK holds the three `repeat_*` columns together, in
  range and with a due date. `next_todo_id` has no foreign key: it marks that the to-do created
  its next occurrence, also after that occurrence is deleted.

The same migration adds `todos` to the plugin registry as inactive. The plugin owns no settings
or jobs and ships no demo seed data. Manifest: route contribution `todos-api`, widget contribution
`agenda-todos`, requirement `members`.

## Acceptance Criteria

- **TODOS-AC-01** Every route answers 401 without a device credential and 503 while the plugin is
  inactive.
- **TODOS-AC-02** A blank, over-long or duplicate list name is rejected and nothing is stored.
- **TODOS-AC-03** Deleting a list removes its to-dos and leaves other lists untouched.
- **TODOS-AC-04** Assigning a child, an archived member or an unknown member is rejected on
  create and on edit.
- **TODOS-AC-05** A to-do whose assignee was archived later is still readable, still filterable
  by that id, and still editable and completable.
- **TODOS-AC-06** Completing twice returns the first `completedAt`; reopening twice leaves the
  to-do open.
- **TODOS-AC-07** The default listing returns open to-dos by due date with undated ones last;
  `dueBy` includes overdue to-dos and excludes undated ones.
- **TODOS-AC-08** A body with an unsupported field is rejected; `null` clears notes, due date and
  assignee.

- **TODOS-AC-09** The navigation shows To-dos only while the plugin is active; deactivating
  to-dos keeps Meals, and deactivating meals keeps To-dos.
- **TODOS-AC-10** The page lists the selected list's open to-dos in API order and marks an overdue
  one with text and its date.
- **TODOS-AC-11** The assignee picker offers active parents only and accepts nobody.
- **TODOS-AC-12** The agenda group lists open to-dos due today, then overdue ones; undated and
  future to-dos are absent; completing a row removes it; the group is absent while the plugin is
  inactive.
- **TODOS-AC-13** The agenda shows its empty message only with no events and no due to-dos.
- **TODOS-AC-14** On the page, deleting a list asks for the admin PIN; a wrong or cancelled PIN
  deletes nothing, and no other action asks for it.
- **TODOS-AC-15** A page open while the plugin is deactivated says that to-dos are turned off.
- **TODOS-AC-16** A rule without a due date is rejected on create and on edit, and clearing the
  due date of a repeating to-do is rejected unless the same request clears the rule.
- **TODOS-AC-17** Completing a repeating to-do answers with one open next occurrence that has the
  same list, title, notes, assignee and rule. A second completion, several completions sent at
  once and a completion after a reopen create no other, and reopening keeps the one created.
- **TODOS-AC-18** The next due date advances by days, weeks, months or years; a month step from
  the 31st clamps to the last day of a shorter month and returns to the 31st; 29 February returns
  in the next leap year; a to-do finished several cycles late gets one next date after the
  household's today, taken in the household timezone.
- **TODOS-AC-19** The next occurrence is unassigned when the assignee is no longer an active
  parent, and the completion succeeds.
- **TODOS-AC-20** `0004_todo_repeat.sql` keeps the to-dos of an existing database, and the table
  refuses a rule that is incomplete, out of range or without a due date.
- **TODOS-AC-21** The form offers the repeat rule only with a due date; a repeating row is marked
  with a label in the UI language; after completing one, its next occurrence is in the list.

Tests: `tests/boundary/todos-access.test.ts`, `todos-lists.test.ts`, `todos-items.test.ts`,
`todos-assignee.test.ts`, `todos-repeat.test.ts`, `todos-rule-b.test.ts`;
`tests/client/todos-board.test.tsx`, `todos-agenda.test.tsx`, `todos-nav.test.tsx`,
`todos-presentation.test.ts`, `todos-repeat.test.ts`, `api.test.ts`; `tests/e2e/todos.spec.ts`
runs the page, the agenda group and a repeating to-do against the real server.

## Open Decisions

- Whether to-dos appear in the full Calendar page.
- Whether the kiosk remembers the selected list.
- Whether to-dos feed a Daily Briefing block or emit events.

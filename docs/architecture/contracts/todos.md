# To-dos Domain Contract

Status: maintained contract
Depends on decisions: `ADR-001`, `ADR-002`, `ADR-003`, `ADR-006`, `ADR-039`, `ADR-054`, `ADR-068`

## Purpose

To-dos for the adults of the household: things to get done once, grouped in lists, with an
optional due date and an optional adult assignee. They are separate from routines and chores,
which belong to the children and repeat.

Delivered: the server module, the HTTP API, the Plugin Management entry, the kiosk page `/todos`
and a group in the Home agenda. To-dos are not shown in the full Calendar page (`/calendar`).

## Vocabulary

- **List**: a named group of to-dos. Every to-do belongs to exactly one list.
- **To-do**: a title with optional notes, due date and assignee. It is **done** while
  `completedAt` is set and **open** otherwise.
- **Assignee**: the adult responsible for a to-do, stored as a member id.

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
- **Complete and reopen**: both return the to-do.

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
| `POST /api/todos/{id}/completion`   | 200 `Todo`; 404                                     |
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

## Events

Emits none; subscribes to none.

## Data / Setup Contract

Owned tables, created by `drizzle/0003_todos.sql`:

- `todo_lists` (`id`, `name` unique, `created_at`, `updated_at`).
- `todo_items` (`id`, `list_id` → `todo_lists.id` ON DELETE CASCADE, `title`, `notes`,
  `due_date`, `assignee_member_id`, `completed_at`, `created_at`, `updated_at`), indexed on
  `list_id` and `due_date`.

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

Tests: `tests/boundary/todos-access.test.ts`, `todos-lists.test.ts`, `todos-items.test.ts`,
`todos-assignee.test.ts`, `todos-rule-b.test.ts`; `tests/client/todos-board.test.tsx`,
`todos-agenda.test.tsx`, `todos-nav.test.tsx`, `todos-presentation.test.ts`, `api.test.ts`;
`tests/e2e/todos.spec.ts` runs the page and the agenda group against the real server.

## Open Decisions

- Whether to-dos appear in the full Calendar page.
- Whether the kiosk remembers the selected list.
- Whether to-dos feed a Daily Briefing block or emit events.

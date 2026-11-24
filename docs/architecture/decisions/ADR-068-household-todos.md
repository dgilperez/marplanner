# ADR-068 — Household to-dos

- **Status**: proposed (2026-11-23)
- **Context**: the kiosk tracks the children's routines and chores, and nothing tracks what the
  adults of the household have to get done, such as paperwork or repairs. Those items have no
  schedule and no streak, so they do not fit the routines model.

## Decision

A first-party plugin, `todos`, owns household to-dos. It follows ADR-039: a manifest entry, a
module that reaches the host only through `src/server/host-api`, its own tables and a forward
migration. It starts inactive.

- **Lists.** Every to-do belongs to exactly one list. A list has a name, unique among lists, and
  deleting a list deletes its to-dos.
- **To-do.** A title, optional notes, an optional due date (strict `YYYY-MM-DD`, ADR-006) and an
  optional assignee. A to-do is done while `completedAt` is set. Completing and reopening are
  separate idempotent commands; the edit command never changes completion.
- **Adults-only assignee.** A write that sets or changes the assignee requires an active member
  whose role is `parent` (ADR-001, ADR-002). Children already have chores, and a to-do carries
  no reward or streak for them. The check runs only when the assignee changes, so a to-do whose
  assignee was archived later stays editable.
- **Soft member reference.** `todo_items.assignee_member_id` is a plain column with no foreign
  key to `members` (ADR-039 §3, ADR-054). Reads return the stored id even when that member is
  archived or missing; the client decides how to show it. The role check is composed in the
  plugin from the host API's `listActiveMembers`, so the host API gains no export.
- **Naming.** The plugin is "To-dos" in English and "Pendientes" in Spanish. The kiosk already
  calls the children's chores "Tasks" / "Tareas", so this plugin never uses "tasks" in an id,
  route, table or label.
- **Table names.** ADR-039 §3 asks for id-prefixed tables. The installed plugins name their
  tables after the thing stored (`recipes`, `meal_plans`, `reminder`, `print_jobs`,
  `daily_messages`) and record ownership in `tests/boundary/data-ownership.test.ts`. This plugin
  follows that practice with `todo_lists` and `todo_items`, which also share a `todo_` stem.
- **Registry.** `plugin_activation_registry.plugin_id` is a closed CHECK, so
  `drizzle/0003_todos.sql` rebuilds that table to admit `todos` and inserts its row as
  `inactive`. An existing household keeps the state of its other plugins.

- **Kiosk page.** `/todos` is a family route, shown in the household navigation while the plugin
  is active and gated by the `todos-api` route contribution, the way `/meals` is gated by
  `meals-recipes-api`. It has no admin placement. Its writes do not ask for the admin PIN: the
  Calendar page creates, edits and deletes local events without it, the PIN is advisory
  (ADR-007), and the backend authorizes by device credential either way.
- **Deleting a list asks for the admin PIN.** It is the one action on the page that removes many
  to-dos at once, so the kiosk asks for the PIN before the confirmation, with the same PIN pad as
  the admin gate (`src/client/admin/AdminPinPad.tsx`). This is a gate of the kiosk UI:
  `DELETE /api/todos/lists/{id}` still accepts the call from any provisioned device. The PIN
  covers that one deletion and does not unlock the admin area. An admin session that is already
  unlocked skips the PIN, but the shell locks the session whenever the kiosk leaves `/admin`, so
  on `/todos` that happens only with the development PIN bypass.
- **Navigation gate per plugin.** The household chrome used to hide every plugin-owned route when
  meals was inactive. Each plugin-owned route is now hidden by its own plugin's state.
- **Home agenda.** The plugin contributes a widget, `agenda-todos`, that `TodayAgenda` hosts as
  a third group after "All day" and "Scheduled". It lists open to-dos with a due date on or
  before the household date. The agenda passes the household date and its Members read to the
  group and learns back only whether the group occupies room, which it needs for its empty
  message. A fault in the group is contained by the contribution boundary.
- **Calendar page.** To-dos are not shown in `/calendar`. That page reads calendar occurrences,
  and mixing dated to-dos into its week and month grids is a separate decision.
- **Selection.** The selected list is component state. No kiosk page persists view state across a
  reload (the Calendar page's week or month mode is not kept either), so this page does not.

### Recurrence (2026-11-24)

Households have to-dos that come back: a vehicle inspection, an insurance renewal, a boiler
service, a filter change.

- **Rule.** A to-do may carry `repeat: { every, unit }` with `every` from 1 to 99 and `unit` one
  of `day`, `week`, `month`, `year`. There is no end date, no count and no weekday pattern;
  routines already cover weekly patterns for the children. A rule needs a due date, because the
  due date is what it counts from.
- **Next occurrence on completion.** The server creates the next to-do when the current one is
  completed, in the same transaction, instead of materialising a series or running a job. Only
  one occurrence of a repeating to-do is open unless someone reopens a done one, and the plugin
  still owns no scheduler job. The copy carries list, title, notes, assignee and rule.
- **Once per to-do.** `todo_items.next_todo_id` records the id of the occurrence a to-do created.
  It has no foreign key and is never cleared, so reopening and completing again creates nothing,
  also after the created occurrence was deleted. Together with the `completed_at IS NULL` guard of
  the completion update this keeps completion idempotent. A self-referencing foreign key with
  `SET NULL` was rejected: deleting the occurrence would make the to-do create another one.
- **Reopen keeps the occurrence.** Reopening a done repeating to-do leaves the occurrence it
  created. Deleting it would lose edits made to it, and the household can delete the one it does
  not want.
- **Next due date.** The due date advances by whole intervals until it is strictly after the
  household's current date (ADR-005). Finishing something three cycles late leaves one to-do, not
  three overdue ones, and the cycle stays on its original dates instead of drifting to the day of
  completion. A date that would pass the year 9999 has no next occurrence.
- **Anchor day.** A month or year step lands on the day of the month the rule was set on, or on
  the last day of a shorter month: 31 January, 28 February, 31 March. The clamped date alone
  cannot say that the 28th came from a 31st, so `todo_items.repeat_anchor_day` stores it and the
  next occurrence inherits it. A write that changes the due date or the rule sets it from the due
  date again; a write that sends the stored values keeps it. The anchor is not in the API.
- **Assignee fallback.** The next occurrence keeps the assignee only while that member is an
  active parent and is unassigned otherwise. The check that rejects such an assignee on a write
  (above) would otherwise make a completion fail for a reason the person completing cannot fix.
- **Completion response.** `POST /api/todos/{id}/completion` answers `TodoCompletion`: every field
  of `Todo` at the top level, plus `nextOccurrence`, a `Todo` or null. A client that reads the
  response as a to-do keeps working. Reopen still answers `Todo`.
- **Shared date math.** `src/shared/todoRepeat.ts` holds the rule's validation and the date steps
  as pure functions over `YYYY-MM-DD` strings, with UTC calendar arithmetic only. The server and
  the in-memory API of the client tests both use it.
- **Migration.** `drizzle/0004_todo_repeat.sql` rebuilds `todo_items` with the four columns and
  one CHECK that holds the rule together, in range and with a due date. It registers no plugin, so
  `PLUGIN_REGISTRATION_MIGRATIONS` is unchanged.
- **Repeat mark.** Rows of the To-dos page show an icon with an accessible name such as "Repeats
  every 2 weeks". The Home agenda rows do not, to keep them as compact as event rows.

## Consequences

- The plugin delivers the server, the HTTP API (`/api/todos`, `/api/todos/lists`), the Plugin
  Management label, the kiosk page and the Home agenda group. The manifest declares the
  `todos-api` route contribution and the `agenda-todos` widget contribution.
- The agenda gained a host slot for a plugin group. `AgendaGroup`, `AgendaRow` and
  `AgendaDetails` moved to `src/client/home/AgendaGroup.tsx` so the plugin's rows are drawn by
  the same components as the event rows.
- The client helpers `apiFetch`/`readJson` (`src/client/lib/api.ts`) and `formatCalendarDate`
  (`src/client/lib/household-date.ts`) replace per-feature copies in the agenda, the meals
  workspace and the Calendar page.
- A member's role can change after assignment. A to-do assigned to a parent who later becomes a
  child keeps its assignee through every edit that leaves the assignee as stored, the same way an
  archived assignee is kept. The assignee is checked again only when an edit names a different
  one, so it changes when someone picks another adult or nobody.
- To-dos emit no events and feed no Daily Briefing block. Either would be a later decision.
- The response of the completion command gained a field. `Todo` gained `repeat`, which is null on
  every to-do stored before `0004_todo_repeat.sql`.
- A database that has applied `0004_todo_repeat.sql` does not start on a build without that file,
  as with every forward migration
  ([database lifecycle](../database-lifecycle.md#forward-migrations)).
- Adding the tenth plugin widened every closed inventory of plugin ids: the shared id list, the
  OpenAPI enum, the registry CHECK and the reviewed cohort fixture.

## Traceability

- Contract: [To-dos](../contracts/todos.md). Feature: [to-dos](../../features/todos.md).
- Related: ADR-001, ADR-002, ADR-005, ADR-006, ADR-029, ADR-039, ADR-054.

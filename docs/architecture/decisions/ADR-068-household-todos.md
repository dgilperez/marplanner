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
- Adding the tenth plugin widened every closed inventory of plugin ids: the shared id list, the
  OpenAPI enum, the registry CHECK and the reviewed cohort fixture.

## Traceability

- Contract: [To-dos](../contracts/todos.md). Feature: [to-dos](../../features/todos.md).
- Related: ADR-001, ADR-002, ADR-006, ADR-029, ADR-039, ADR-054.

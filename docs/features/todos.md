# Feature: To-dos

Behavior reference. The [owning contract](../architecture/contracts/todos.md) defines invariants
and extension limits; [ADR-068](../architecture/decisions/ADR-068-household-todos.md) records the
decisions.

To-dos are things the adults of the household have to get done once, such as renewing a passport
or calling the plumber. They are grouped in lists, and each one may carry notes, a due
date and an adult assignee. The plugin is called "To-dos" in English and "Pendientes" in Spanish;
"Tasks" / "Tareas" already means the children's chores.

The plugin starts inactive in Admin → Plugins. While it is active the kiosk has a To-dos page at
`/todos` and the Home agenda lists the to-dos that are due. To-dos do not appear in the full
Calendar page (`/calendar`); that is not delivered.

## User workflows

### User Story 1 — Keep lists

An adult creates lists such as "Home" or "Paperwork", renames them, and deletes one that is no
longer needed together with everything in it. Lists come back ordered by name, each with its
number of open to-dos.

### User Story 2 — Write a to-do

An adult adds a to-do to a list with a title, and optionally notes, a due date and the adult who
will do it. Any of those can be changed later, the to-do can be moved to another list, and notes,
due date and assignee can be cleared.

### User Story 3 — Finish and reopen

An adult marks a to-do done and can reopen it. Marking a done to-do done again keeps the original
completion time.

### User Story 4 — See what is pending

A client lists open to-dos, optionally for one list, for one assignee, or due on or before a
date. Overdue to-dos are part of "due on or before"; undated ones are not.

### User Story 5 — Work through a list on the kiosk

An adult opens To-dos from the navigation. The lists are pills across the top, each with its
number of open to-dos, in alphabetical order for the UI language, and the first one is selected. The adult picks a list, types a title and
presses Enter to add a to-do, or opens the full form to set notes, a due date, an adult assignee
and the list. Checking a to-do completes it. The "Done" section is collapsed; opening it shows the
done to-dos of the list, and unchecking one reopens it. From the same page the adult creates a
list, renames the selected one, or deletes it. Deleting a list asks for the admin PIN and then for
a confirmation that says how many to-dos go with it; the confirmation cannot be accepted until
that number is known or its read has failed. Nothing else on the page asks for the PIN, which
matches how the Calendar page handles the household's own events. The PIN is a gate of the kiosk
UI: the API accepts the deletion from any provisioned device.

### User Story 6 — See what is due on Home

The Home agenda shows a "To-dos" group after the day's events with the open to-dos due today and
the overdue ones, the overdue ones marked and dated. Each row has a checkbox that completes the
to-do, and a completed row leaves the group. The group reads again when the household day changes,
when the tablet becomes visible again and after a completion.

### Edge Cases

- A list name that another list already has is a conflict. Names are compared exactly after
  trimming, so `Home` and `home` are two lists.
- A child, an archived member or an unknown member cannot be assigned.
- A to-do keeps its assignee when that member is archived later. It stays readable and editable;
  only choosing a new assignee is checked.
- A body with a field the API does not know is rejected, including `completedAt`: completion has
  its own commands.
- Blank notes are stored as no notes.
- A list name or title made only of spaces or of characters that draw nothing, such as a
  zero-width space, counts as blank.
- A wrong PIN or a cancelled PIN entry leaves the list as it was. The PIN is asked again for each
  deletion.
- A second Enter while a quick add is on its way does not add the to-do twice.
- While the plugin is inactive every route answers `503 plugin_unavailable`; the data is kept.
  The navigation entry and the agenda group are hidden, and `/todos` shows the shared
  "unavailable" notice inside the household chrome. A To-dos page that was already open when the
  plugin was deactivated says "To-dos are turned off." on its next request.
- The To-dos page marks overdue to-dos against the household date and reads that date again at
  household midnight and when the tablet wakes.
- The assignee picker lists active adults. A to-do whose assignee was archived later still shows
  that member's name, and its form keeps that member selectable so that editing another field does
  not replace them.
- A to-do with no due date never appears in the Home agenda. A to-do due on a later date appears
  there on that date.
- The agenda says "Nothing scheduled today." only when there are no events and no due to-dos. It
  says nothing while the plugin catalog or the due to-dos are still loading.
- A failed read on the To-dos page or in the agenda group shows a notice with a retry and leaves
  the rest of the screen working.
- The selected list is not remembered across a reload; the page opens on the first list.

## Requirements

### Functional Requirements

- **FR-001**: A list name MUST be non-blank and at most 80 characters after trimming, and unique
  among lists. Contract: TODOS-INV-01.
- **FR-002**: A to-do MUST belong to exactly one existing list, and deleting a list MUST delete
  its to-dos. Contract: TODOS-INV-02.
- **FR-003**: A title MUST be non-blank and at most 200 characters after trimming; notes MUST be
  at most 2000 characters. Contract: TODOS-INV-03.
- **FR-004**: A due date MUST be a strict calendar-valid `YYYY-MM-DD` or absent. Contract:
  TODOS-INV-04.
- **FR-005**: A write that sets or changes the assignee MUST name an active member whose role is
  `parent`. Contract: TODOS-INV-05.
- **FR-006**: Reads MUST return the stored assignee id when that member is archived or missing.
  Contract: TODOS-INV-06.
- **FR-007**: Completing MUST be idempotent and keep the first completion time; reopening MUST be
  idempotent. Contract: TODOS-INV-07.
- **FR-008**: A write with a non-object body or an unsupported field MUST be rejected with nothing
  written; `null` in an edit MUST clear a nullable field. Contract: TODOS-INV-08.
- **FR-009**: The listing MUST default to open to-dos and order them open before done, then by
  due date ascending with undated last, then by creation. Contract: TODOS-AC-07.
- **FR-010**: Every route MUST require the device credential and MUST answer 503 while the plugin
  is inactive. Contract: TODOS-AC-01.

- **FR-011**: The family navigation MUST show To-dos only while the plugin is active, and its
  state MUST NOT affect the entry of another plugin. Contract: TODOS-AC-09.
- **FR-012**: The To-dos page MUST list the open to-dos of the selected list in API order with
  title, due date in the UI language and assignee, and MUST mark an overdue to-do with text.
  Contract: TODOS-AC-10.
- **FR-013**: The assignee picker MUST offer only active members whose role is `parent`, and MUST
  allow no assignee. Contract: TODOS-INV-05, TODOS-AC-11.
- **FR-014**: The Home agenda MUST list open to-dos due on or before the household date, today's
  before overdue ones, and MUST hide the group while the plugin is inactive. Contract: TODOS-AC-12.
- **FR-015**: The agenda's empty message MUST appear only when there are neither events nor due
  to-dos. Contract: TODOS-AC-13.

### Key Entities

- **List**: id, name, created/updated timestamps; `openCount` is derived on read.
- **To-do**: id, list id, title, notes, due date, assignee member id, completion time,
  created/updated timestamps.

## Assumptions

- Member roles and lifecycle are owned by Members (ADR-001, ADR-002); this plugin reads them
  through the host API.
- Due dates are household-local calendar dates with no time of day.
- The plugin owns no settings or scheduled jobs and ships no demo seed data.

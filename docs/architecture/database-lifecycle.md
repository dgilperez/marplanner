# Database lifecycle and demo profile contract

This contract covers the installed migration runner, public demo profile, calendar source writes and backup/restore lifecycle. Public seeds target disposable demo storage and refuse unrelated household data.

## Seed module

```ts
export interface SeedContext {
  db: DatabaseConnection;
  asOfDate: string;
  nowMs: number;
}

export interface SeedModule {
  id: string;
  run(context: SeedContext): void | Promise<void>;
}
```

- `id` is globally unique and stable.
- Public filenames match `seed-NNN-*.ts`; private filenames match `seed*-PRIVATE.*`.
- Discovery is lexical and reported before execution.
- The runner migrates and validates the disposable target before the first module.
- On a target with no household/profile rows beyond migration bookkeeping and fixed `day_periods`, it
  creates a `simpsons-demo` marker with `running` status; it marks `complete`
  only after the selected module list succeeds.
- A rerun requires that marker and a successful scan against the profile's complete owned-record
  inventory, including declared singleton Settings keys. Any unrelated row refuses the run unchanged.
- Each module runs in its own transaction and canonicalizes only documented IDs.
- Failure stops the run, exits non-zero, identifies the module, and never logs private payloads.

## CLI

```text
npm run seed -- [--as-of YYYY-MM-DD]
npm run seed:public -- [--as-of YYYY-MM-DD]
npm run seed:private -- [--as-of YYYY-MM-DD]
```

`seed` (`seed:all`) runs `seed:public` then `seed:private`. `seed:public` executes public
modules only; `seed:private` executes private overlays only (after public seed on an empty
or profile-owned store). Unknown arguments, invalid dates, invalid/duplicate modules, unsafe
destinations, and module errors fail visibly. Success reports mode, `as-of`, ordered module
IDs, and completion, but not private URLs or device identifiers.

## Calendar source write seam

```ts
interface CalendarExternalSourceInput {
  id: string;
  name: string;
  provider: string;
  feedUrl: string;
  enabled: boolean;
  pollIntervalMin: number;
}

upsertExternalSource(input: CalendarExternalSourceInput): CalendarExternalSourcePrivate
listExternalSources(): CalendarExternalSourcePublic[]
```

The upsert validates scheme, credentials, hostname/address safety, DNS results, label, and interval.
Provider is display-only and normalizes to `google|microsoft|apple|ics_generic`, with unknown input
mapped to `ics_generic`. `CalendarExternalSourcePublic` exposes only a masked URL; the raw stored URL
never reaches clients. The seam does not fetch HTTP, parse iCalendar, create events, or update sync
state. Shared types, OpenAPI, and boundary tests enforce the redacted DTO.

## Restore result extension

The existing union adds:

```ts
{
  status: "unsupported_lineage";
  message: string;
}
```

This means readable migration metadata lacks `0000_baseline.sql`. It differs from
`downgrade_rejected` (unknown future identity) and `incompatible_backup` (unreadable SQLite or
metadata). The HTTP status uses the existing incompatible-version rejection class. The stable English
message contains no raw path or database detail.

## Backups UI

No new action is added. Existing list, snapshot, upload, binary/SQL download, typed-name restore,
delete, reload, and safe server-error display remain the contract.

## Private overlays

`.gitignore` contains `seeds/seed*-PRIVATE.*`. Private modules use the same interface and may persist
local configuration only. Tests use synthetic temporary fixtures; real values never appear in Git,
snapshots, logs, or expected output.

## Migration squash (2026-10-16)

`drizzle/` starts with one migration, `0000_baseline.sql`: `drizzle-kit generate` output for
`src/server/db/schema.ts`, plus `STRICT` on the three calendar-sync tables, the four day-period
rows, and the lineage and plugin registry seed (every plugin inactive). It replaced
`0000_current_baseline.sql` and the deltas `0001_calendar_feed_sync`, `0002_plugin_lifecycle`,
`0003_calendar_event_details`, `0004_member_palette` and `0005_daily_briefing_schedule`, whose
end state it reproduces (ten-colour `members` CHECK, `daily_briefing_optin.weekdays`).

Schema changes after the squash ship as numbered forward migrations applied after the baseline
(`0001_reminder_content.sql`, #96, adds a reminder's `content_type`/`emojis`), so an existing
household upgrades in place; the baseline itself is never edited. A migration that needs a table
rebuild (SQLite cannot add a CHECK in place) may drop and recreate a parent table: the runner turns
foreign keys off around the batch and runs `foreign_key_check` before commit.
`tests/integration/database-baseline.test.ts` compares the baseline plus every forward migration
with a clean `drizzle-kit generate` of the schema.

No upgrade path exists from before the squash: v2 had no installed database with real data. A development database or a
backup created before the squash is **unsupported**. The runner refuses a non-empty ledger before
writing anything (`Unsupported migration history.`); delete the `DATA_DIR` database and reseed.
Restore reports such a backup as `unsupported_lineage`. `installation_lineage.kind` is now always
`fresh`; the `prior_baseline` lineage (an install that predated plugin lifecycle) no longer exists.

## Forward migrations

- `0001_reminder_content.sql` (#96): a reminder's `content_type` and `emojis`.
- `0002_member_celebration.sql` (#92): rebuilds `members` with `celebration_preset` (`confetti`
  default; one of `confetti`, `stars`, `videogames`, `soccer`, `fairytale`, `custom`) and
  `celebration_emojis` (a JSON array of 1–6 items when the preset is `custom`, NULL otherwise),
  each with a CHECK. Existing members read as `confetti`.
- `0003_todos.sql` (ADR-068): creates `todo_lists` and `todo_items` for the to-dos plugin, and
  rebuilds `plugin_activation_registry` so its `plugin_id` CHECK accepts `todos`, keeping every
  existing row. It then inserts the `todos` row as `inactive`. The runner expects nine registry
  rows before this migration is in the ledger and ten after.
- `0004_todo_repeat.sql` (ADR-068): rebuilds `todo_items` with `repeat_every`, `repeat_unit`,
  `repeat_anchor_day` and `next_todo_id`, and a CHECK that keeps the three `repeat_*` columns set
  together, in range and with a due date. Existing to-dos are copied with all four NULL. It
  registers no plugin, so the registry count is unchanged.

The runner identifies a migration by its file name, not by its number. On each start it sorts the
file names in `drizzle/`, refuses a ledger that names a file the build does not ship
(`Unsupported migration history.`) and applies, in name order, every file the ledger lacks. It does
not check that a pending file sorts after the ones already applied. A database with
`0003_todos.sql` in its ledger therefore does not start on a build without that file; the way back
is in [operations](../operations.md#pre-migration-recovery-snapshots).

`0003_todos.sql` was written in a fork. If the upstream project ships a different file with the
same number, a build that merges both has two `0003_*.sql` files and the runner accepts that. A
fresh database applies them in name order, and a database that already has `0003_todos.sql`
applies the other one after it, so the two reach their schema by different routes. That is safe
only while the two files touch different tables. It stops being safe if the other file also
rebuilds `plugin_activation_registry`: a rebuild whose CHECK does not list `todos` fails on the
existing `todos` row, the batch rolls back and the server does not start. A second file that
registers a plugin must also be listed in `PLUGIN_REGISTRATION_MIGRATIONS`
(`src/server/db/migrate.ts`), or the registry count check fails with
`Incomplete plugin lifecycle migration history.` Whoever merges resolves this by renumbering the
migration that has not reached an installed database and making `schema.ts` agree, which
`tests/integration/database-baseline.test.ts` enforces.

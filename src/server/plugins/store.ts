import type { DatabaseConnection } from "../db/client.js";
import type {
  ExtensionId,
  PluginId,
  PluginPublicError,
  PluginState,
  PluginTargetState,
} from "../../shared/plugins.js";
import { SAFE_LIFECYCLE_ERRORS } from "./errors.js";

export type PluginLifecyclePhase =
  | "preparing-settings"
  | "running-migrations"
  | "mounting"
  | "committing-active"
  | "blocking-claims"
  | "draining"
  | "unmounting"
  | "committing-inactive";

export interface PluginRegistryRecord {
  readonly pluginId: PluginId;
  readonly state: PluginState;
  readonly activatedAt: string | null;
  readonly updatedAt: string;
  readonly error: PluginPublicError | null;
}

export interface PluginLifecycleOperation {
  readonly operationId: string;
  readonly pluginId: PluginId;
  readonly targetState: PluginTargetState;
  readonly phase: PluginLifecyclePhase;
  readonly startedAt: string;
  readonly updatedAt: string;
}

/** The part of an async migration after its first await would run outside the transaction. */
function assertSynchronousMigration(apply: () => undefined): void {
  if (apply.constructor.name === "AsyncFunction") {
    throw new TypeError("Plugin migrations must be synchronous.");
  }
}

export class SqlitePluginLifecycleStore {
  constructor(private readonly dbSource: DatabaseConnection | (() => DatabaseConnection)) {}

  private get db(): DatabaseConnection {
    return typeof this.dbSource === "function" ? this.dbSource() : this.dbSource;
  }

  applyPluginMigration(
    pluginId: PluginId,
    migrationId: string,
    appliedAt: string,
    apply: () => undefined
  ): boolean {
    assertSynchronousMigration(apply);
    return this.db.transaction(() => {
      const journaled = this.db
        .prepare(
          `SELECT 1
           FROM plugin_migration_journal
           WHERE plugin_id = ? AND migration_id = ?`
        )
        .get(pluginId, migrationId);
      if (journaled) return false;

      const result = apply();
      if (result !== undefined) throw new TypeError("Plugin migrations must be synchronous.");
      this.db
        .prepare(
          `INSERT INTO plugin_migration_journal (plugin_id, migration_id, applied_at)
           VALUES (?, ?, ?)`
        )
        .run(pluginId, migrationId, appliedAt);
      return true;
    })();
  }

  /** Runs an extension migration under the same journal as a first-party one, and rejects it when
   * it creates, alters or drops a table, index, view or trigger outside the tables prefixed with
   * the extension's data namespace. The check runs inside the migration's transaction, so such a
   * change rolls back. It catches mistakes, not hostile code: an extension reaches the shared
   * database handle through the host API, so it can still change rows in any table or use the
   * temp schema.
   */
  applyExtensionMigration(
    pluginId: ExtensionId,
    dataNamespace: string,
    migrationId: string,
    appliedAt: string,
    apply: () => undefined
  ): boolean {
    // applyPluginMigration only sees the schema-checking wrapper below, so check `apply` itself.
    assertSynchronousMigration(apply);
    const foreignSchema = (): string =>
      JSON.stringify(
        this.db
          .prepare(
            `SELECT type, name, tbl_name AS tableName, sql
             FROM sqlite_schema
             WHERE substr(tbl_name, 1, length(?)) <> ?
               -- SQLite's own bookkeeping, e.g. sqlite_sequence for the first AUTOINCREMENT table.
               AND tbl_name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             ORDER BY type, name`
          )
          .all(`${dataNamespace}_`, `${dataNamespace}_`)
      );
    return this.applyPluginMigration(pluginId, migrationId, appliedAt, () => {
      const before = foreignSchema();
      const result = apply();
      if (foreignSchema() !== before) {
        throw new Error(
          `Extension ${pluginId} migration ${migrationId} changed schema outside ${dataNamespace}_*.`
        );
      }
      return result;
    });
  }

  listExtensionRegistryIds(): string[] {
    return (
      this.db
        .prepare(
          "SELECT plugin_id AS id FROM plugin_activation_registry WHERE plugin_id LIKE 'ext-%' ORDER BY plugin_id"
        )
        .all() as Array<{ id: string }>
    ).map(({ id }) => id);
  }

  /** Extensions are not seeded by a migration: their row is added, inactive, the first time a
   * build that contains them assembles its runtime (ADR-068). Existing rows are left untouched.
   */
  ensureExtensionRegistryRow(pluginId: ExtensionId, now: string): void {
    this.db
      .prepare(
        `INSERT INTO plugin_activation_registry
           (plugin_id, state, activated_at, updated_at, error_code, error_message)
         VALUES (?, 'inactive', NULL, ?, NULL, NULL)
         ON CONFLICT (plugin_id) DO NOTHING`
      )
      .run(pluginId, now);
  }

  getRegistry(pluginId: PluginId): PluginRegistryRecord {
    const row = this.db
      .prepare(
        `SELECT plugin_id AS pluginId,
                state,
                activated_at AS activatedAt,
                updated_at AS updatedAt,
                error_code AS errorCode
         FROM plugin_activation_registry
         WHERE plugin_id = ?`
      )
      .get(pluginId) as
      | {
          pluginId: PluginId;
          state: PluginState;
          activatedAt: string | null;
          updatedAt: string;
          errorCode: PluginPublicError["code"] | null;
        }
      | undefined;
    if (!row) throw new Error(`Plugin registry row is missing for ${pluginId}.`);
    return {
      pluginId: row.pluginId,
      state: row.state,
      activatedAt: row.activatedAt,
      updatedAt: row.updatedAt,
      error: row.errorCode === null ? null : SAFE_LIFECYCLE_ERRORS[row.errorCode],
    };
  }

  getOperation(pluginId: PluginId): PluginLifecycleOperation | null {
    const row = this.db
      .prepare(
        `SELECT operation_id AS operationId,
                plugin_id AS pluginId,
                target_state AS targetState,
                phase,
                started_at AS startedAt,
                updated_at AS updatedAt
         FROM plugin_lifecycle_operations
         WHERE plugin_id = ?`
      )
      .get(pluginId) as PluginLifecycleOperation | undefined;
    return row ?? null;
  }

  listOperations(): readonly PluginLifecycleOperation[] {
    return this.db
      .prepare(
        `SELECT operation_id AS operationId,
                plugin_id AS pluginId,
                target_state AS targetState,
                phase,
                started_at AS startedAt,
                updated_at AS updatedAt
         FROM plugin_lifecycle_operations
         ORDER BY plugin_id`
      )
      .all() as PluginLifecycleOperation[];
  }

  begin(
    pluginId: PluginId,
    operationId: string,
    targetState: PluginTargetState,
    phase: PluginLifecyclePhase,
    now: string
  ): PluginLifecycleOperation {
    this.db
      .prepare(
        `INSERT INTO plugin_lifecycle_operations
           (operation_id, plugin_id, target_state, phase, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(operationId, pluginId, targetState, phase, now, now);
    return this.getOperation(pluginId) as PluginLifecycleOperation;
  }

  beginFault(pluginId: PluginId, operationId: string, now: string): PluginLifecycleOperation {
    const error = SAFE_LIFECYCLE_ERRORS.contribution_failed;
    const operation: PluginLifecycleOperation = {
      operationId,
      pluginId,
      targetState: "inactive",
      phase: "blocking-claims",
      startedAt: now,
      updatedAt: now,
    };
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO plugin_lifecycle_operations
             (operation_id, plugin_id, target_state, phase, started_at, updated_at)
           VALUES (?, ?, 'inactive', 'blocking-claims', ?, ?)`
        )
        .run(operationId, pluginId, now, now);
      const result = this.db
        .prepare(
          `UPDATE plugin_activation_registry
           SET state = 'errored', updated_at = ?, error_code = ?, error_message = ?
           WHERE plugin_id = ?`
        )
        .run(now, error.code, error.message, pluginId);
      if (result.changes !== 1) throw new Error(`Plugin registry row is missing for ${pluginId}.`);
    })();
    return operation;
  }

  setPhase(pluginId: PluginId, phase: PluginLifecyclePhase, now: string): void {
    const result = this.db
      .prepare(
        `UPDATE plugin_lifecycle_operations
         SET phase = ?, updated_at = ?
         WHERE plugin_id = ?`
      )
      .run(phase, now, pluginId);
    if (result.changes !== 1)
      throw new Error(`Plugin lifecycle operation is missing for ${pluginId}.`);
  }

  complete(pluginId: PluginId, state: PluginTargetState, now: string): void {
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE plugin_activation_registry
           SET state = ?,
               activated_at = CASE WHEN ? = 'active' THEN ? ELSE activated_at END,
               updated_at = ?,
               error_code = NULL,
               error_message = NULL
           WHERE plugin_id = ?`
        )
        .run(state, state, now, now, pluginId);
      if (result.changes !== 1) throw new Error(`Plugin registry row is missing for ${pluginId}.`);
      this.deleteOperation(pluginId);
    })();
  }

  fail(pluginId: PluginId, error: PluginPublicError, now: string): void {
    this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE plugin_activation_registry
           SET state = 'errored', updated_at = ?, error_code = ?, error_message = ?
           WHERE plugin_id = ?`
        )
        .run(now, error.code, error.message, pluginId);
      if (result.changes !== 1) throw new Error(`Plugin registry row is missing for ${pluginId}.`);
      this.deleteOperation(pluginId);
    })();
  }

  private deleteOperation(pluginId: PluginId): void {
    const result = this.db
      .prepare("DELETE FROM plugin_lifecycle_operations WHERE plugin_id = ?")
      .run(pluginId);
    if (result.changes !== 1)
      throw new Error(`Plugin lifecycle operation is missing for ${pluginId}.`);
  }
}

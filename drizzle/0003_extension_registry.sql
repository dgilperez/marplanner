-- Third delta after the squashed baseline (ADR-068): the activation registry accepts build-time
-- extensions next to the closed first-party cohort. `plugin_id` is one of the nine first-party ids
-- or matches the extension id pattern `ext-<segment>(-<segment>)*`, segments being `[a-z0-9]+`
-- (GLOB has no repetition operator, so the pattern is spelled as four GLOB terms). No row is
-- added or changed. The table is rebuilt the way `drizzle-kit generate` rebuilds a SQLite table,
-- so it ends up exactly as src/server/db/schema.ts declares it. The runner turns foreign keys off
-- around the batch, so dropping the old table cascades nothing.
CREATE TABLE `__new_plugin_activation_registry` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`activated_at` text,
	`updated_at` text NOT NULL,
	`error_code` text,
	`error_message` text,
	CONSTRAINT "plugin_activation_registry_plugin_id_check" CHECK("__new_plugin_activation_registry"."plugin_id" IN ('daily-briefing', 'printing', 'weather', 'time-announcements', 'backups', 'network-devices', 'meals-recipes', 'reminders', 'daily-messages') OR ("__new_plugin_activation_registry"."plugin_id" GLOB 'ext-[a-z0-9]*' AND "__new_plugin_activation_registry"."plugin_id" NOT GLOB '*[^a-z0-9-]*' AND "__new_plugin_activation_registry"."plugin_id" NOT GLOB '*--*' AND "__new_plugin_activation_registry"."plugin_id" NOT GLOB '*-')),
	CONSTRAINT "plugin_activation_registry_state_check" CHECK("__new_plugin_activation_registry"."state" IN ('active', 'inactive', 'errored')),
	CONSTRAINT "plugin_activation_registry_activated_at_check" CHECK("__new_plugin_activation_registry"."activated_at" IS NULL OR (
        length("__new_plugin_activation_registry"."activated_at") = 24
        AND "__new_plugin_activation_registry"."activated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "__new_plugin_activation_registry"."activated_at") = "__new_plugin_activation_registry"."activated_at"
      )),
	CONSTRAINT "plugin_activation_registry_updated_at_check" CHECK(length("__new_plugin_activation_registry"."updated_at") = 24
        AND "__new_plugin_activation_registry"."updated_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
        AND strftime('%Y-%m-%dT%H:%M:%fZ', "__new_plugin_activation_registry"."updated_at") = "__new_plugin_activation_registry"."updated_at"),
	CONSTRAINT "plugin_activation_registry_error_check" CHECK((
        ("__new_plugin_activation_registry"."error_code" IS NULL AND "__new_plugin_activation_registry"."error_message" IS NULL)
        OR (
          "__new_plugin_activation_registry"."state" = 'errored'
          AND "__new_plugin_activation_registry"."error_code" IS NOT NULL
          AND "__new_plugin_activation_registry"."error_message" IS NOT NULL
          AND (
            ("__new_plugin_activation_registry"."error_code" = 'settings_initialization_failed' AND "__new_plugin_activation_registry"."error_message" = 'Plugin settings could not be prepared.')
            OR ("__new_plugin_activation_registry"."error_code" = 'migration_failed' AND "__new_plugin_activation_registry"."error_message" = 'Plugin data could not be prepared.')
            OR ("__new_plugin_activation_registry"."error_code" = 'runtime_mount_failed' AND "__new_plugin_activation_registry"."error_message" = 'Plugin services could not be started.')
            OR ("__new_plugin_activation_registry"."error_code" = 'drain_failed' AND "__new_plugin_activation_registry"."error_message" = 'Plugin work could not stop safely.')
            OR ("__new_plugin_activation_registry"."error_code" = 'runtime_unmount_failed' AND "__new_plugin_activation_registry"."error_message" = 'Plugin services could not be stopped.')
            OR ("__new_plugin_activation_registry"."error_code" = 'contribution_failed' AND "__new_plugin_activation_registry"."error_message" = 'A plugin contribution failed.')
            OR ("__new_plugin_activation_registry"."error_code" = 'reconciliation_failed' AND "__new_plugin_activation_registry"."error_message" = 'Plugin recovery requires attention.')
          )
        )
      ))
);;--> statement-breakpoint
INSERT INTO `__new_plugin_activation_registry`("plugin_id", "state", "activated_at", "updated_at", "error_code", "error_message") SELECT "plugin_id", "state", "activated_at", "updated_at", "error_code", "error_message" FROM `plugin_activation_registry`;--> statement-breakpoint
DROP TABLE `plugin_activation_registry`;--> statement-breakpoint
ALTER TABLE `__new_plugin_activation_registry` RENAME TO `plugin_activation_registry`;

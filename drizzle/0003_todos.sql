-- To-dos plugin (ADR-068): `todo_lists` and `todo_items`, plus the tenth registry row.
-- `todo_items.assignee_member_id` is a soft reference with no foreign key to `members` (ADR-039 §3).
-- The plugin id set of `plugin_activation_registry` is a table CHECK, which SQLite cannot widen in
-- place, so the table is rebuilt the way `drizzle-kit generate` rebuilds a SQLite table and ends up
-- exactly as src/server/db/schema.ts declares it. The runner turns foreign keys off around the
-- batch, so dropping the old table leaves `plugin_lifecycle_operations` and
-- `plugin_migration_journal` rows (and their foreign keys by name) intact. `todos` starts inactive.
CREATE TABLE `todo_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "todo_lists_name_check" CHECK(length(trim("todo_lists"."name")) > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `todo_lists_unique_name` ON `todo_lists` (`name`);--> statement-breakpoint
CREATE TABLE `todo_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`due_date` text,
	`assignee_member_id` text,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`list_id`) REFERENCES `todo_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "todo_items_title_check" CHECK(length(trim("todo_items"."title")) > 0),
	CONSTRAINT "todo_items_due_date_shape_check" CHECK("todo_items"."due_date" IS NULL OR "todo_items"."due_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
--> statement-breakpoint
CREATE INDEX `todo_items_list_id_idx` ON `todo_items` (`list_id`);--> statement-breakpoint
CREATE INDEX `todo_items_due_date_idx` ON `todo_items` (`due_date`);--> statement-breakpoint
CREATE TABLE `__new_plugin_activation_registry` (
	`plugin_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`activated_at` text,
	`updated_at` text NOT NULL,
	`error_code` text,
	`error_message` text,
	CONSTRAINT "plugin_activation_registry_plugin_id_check" CHECK("__new_plugin_activation_registry"."plugin_id" IN ('daily-briefing', 'printing', 'weather', 'time-announcements', 'backups', 'network-devices', 'meals-recipes', 'reminders', 'daily-messages', 'todos')),
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
);--> statement-breakpoint
INSERT INTO `__new_plugin_activation_registry` (`plugin_id`, `state`, `activated_at`, `updated_at`, `error_code`, `error_message`)
SELECT `plugin_id`, `state`, `activated_at`, `updated_at`, `error_code`, `error_message` FROM `plugin_activation_registry`;
--> statement-breakpoint
DROP TABLE `plugin_activation_registry`;--> statement-breakpoint
ALTER TABLE `__new_plugin_activation_registry` RENAME TO `plugin_activation_registry`;--> statement-breakpoint
INSERT INTO `plugin_activation_registry` (`plugin_id`, `state`, `activated_at`, `updated_at`, `error_code`, `error_message`)
SELECT 'todos', 'inactive', NULL, `installation_lineage`.`captured_at`, NULL, NULL
FROM `installation_lineage`;

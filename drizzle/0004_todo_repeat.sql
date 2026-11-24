-- Repeating to-dos (ADR-068): a to-do may carry a rule "every N days, weeks, months or years".
-- `repeat_every`, `repeat_unit` and `repeat_anchor_day` are set together and need a due date;
-- `next_todo_id` records the occurrence a completed repeating to-do created, with no foreign key.
-- Existing to-dos get no rule. The table is rebuilt the way `drizzle-kit generate` rebuilds a
-- SQLite table, because a named table CHECK cannot be added in place, and ends up exactly as
-- src/server/db/schema.ts declares it. The runner turns foreign keys off around the batch, so
-- dropping the old table cascades nothing.
CREATE TABLE `__new_todo_items` (
	`id` text PRIMARY KEY NOT NULL,
	`list_id` text NOT NULL,
	`title` text NOT NULL,
	`notes` text,
	`due_date` text,
	`assignee_member_id` text,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`repeat_every` integer,
	`repeat_unit` text,
	`repeat_anchor_day` integer,
	`next_todo_id` text,
	FOREIGN KEY (`list_id`) REFERENCES `todo_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "todo_items_title_check" CHECK(length(trim("__new_todo_items"."title")) > 0),
	CONSTRAINT "todo_items_due_date_shape_check" CHECK("__new_todo_items"."due_date" IS NULL OR "__new_todo_items"."due_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "todo_items_repeat_check" CHECK(CASE WHEN "__new_todo_items"."repeat_unit" IS NULL THEN "__new_todo_items"."repeat_every" IS NULL AND "__new_todo_items"."repeat_anchor_day" IS NULL ELSE "__new_todo_items"."repeat_unit" IN ('day', 'week', 'month', 'year') AND typeof("__new_todo_items"."repeat_every") = 'integer' AND "__new_todo_items"."repeat_every" BETWEEN 1 AND 99 AND typeof("__new_todo_items"."repeat_anchor_day") = 'integer' AND "__new_todo_items"."repeat_anchor_day" BETWEEN 1 AND 31 AND "__new_todo_items"."due_date" IS NOT NULL END)
);
--> statement-breakpoint
INSERT INTO `__new_todo_items`("id", "list_id", "title", "notes", "due_date", "assignee_member_id", "completed_at", "created_at", "updated_at") SELECT "id", "list_id", "title", "notes", "due_date", "assignee_member_id", "completed_at", "created_at", "updated_at" FROM `todo_items`;--> statement-breakpoint
DROP TABLE `todo_items`;--> statement-breakpoint
ALTER TABLE `__new_todo_items` RENAME TO `todo_items`;--> statement-breakpoint
CREATE INDEX `todo_items_list_id_idx` ON `todo_items` (`list_id`);--> statement-breakpoint
CREATE INDEX `todo_items_due_date_idx` ON `todo_items` (`due_date`);

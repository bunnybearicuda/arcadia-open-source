CREATE TABLE `deleted_conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`deleted_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `archived_at` text;
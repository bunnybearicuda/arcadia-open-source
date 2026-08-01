CREATE TABLE `app_settings` (
	`id` text PRIMARY KEY NOT NULL,
	`monthly_budget` real DEFAULT 5 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `conversation_members` (
	`conversation_id` text NOT NULL,
	`companion_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`conversation_id`, `companion_id`)
);
--> statement-breakpoint
ALTER TABLE `conversations` ADD `kind` text DEFAULT 'solo' NOT NULL;--> statement-breakpoint
ALTER TABLE `messages` ADD `companion_id` text;--> statement-breakpoint
ALTER TABLE `messages` ADD `cost_usd` real;
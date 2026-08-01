CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`companion_id` text NOT NULL,
	`title` text DEFAULT 'New conversation' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`role` text NOT NULL,
	`content_json` text NOT NULL,
	`provider` text,
	`model` text,
	`status` text DEFAULT 'complete' NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE `companions` ADD `companion_bubble_color` text DEFAULT '#0f4c46' NOT NULL;--> statement-breakpoint
ALTER TABLE `companions` ADD `user_bubble_color` text DEFAULT '#6d3f9b' NOT NULL;
CREATE TABLE `memory_checkpoints` (
	`conversation_id` text PRIMARY KEY NOT NULL,
	`last_message_rowid` integer DEFAULT 0 NOT NULL,
	`last_processed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`companion_id` text NOT NULL,
	`conversation_id` text,
	`source` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`item_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

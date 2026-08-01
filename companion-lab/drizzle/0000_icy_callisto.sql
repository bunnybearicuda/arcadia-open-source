CREATE TABLE `companions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`identity` text DEFAULT '' NOT NULL,
	`traits` text DEFAULT '' NOT NULL,
	`boundaries` text DEFAULT '' NOT NULL,
	`voice_notes` text DEFAULT '' NOT NULL,
	`provider` text DEFAULT 'anthropic' NOT NULL,
	`model` text DEFAULT 'claude-sonnet-4-5' NOT NULL,
	`monthly_cap` real DEFAULT 5 NOT NULL,
	`per_message_cap` real DEFAULT 0.25 NOT NULL,
	`accent` text DEFAULT '#55bfff' NOT NULL,
	`autonomy` text DEFAULT 'manual' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

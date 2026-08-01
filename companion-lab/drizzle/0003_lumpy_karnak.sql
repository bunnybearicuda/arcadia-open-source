CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text DEFAULT 'kian' NOT NULL,
	`scope` text DEFAULT 'private' NOT NULL,
	`category` text DEFAULT 'memory' NOT NULL,
	`content` text NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_ref` text,
	`source_url` text,
	`priority` integer DEFAULT 1 NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`relationship` text DEFAULT '' NOT NULL,
	`profile_text` text DEFAULT '' NOT NULL,
	`notion_source` text DEFAULT '' NOT NULL,
	`notion_source_name` text DEFAULT '' NOT NULL,
	`notion_last_synced_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

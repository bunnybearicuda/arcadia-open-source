CREATE TABLE `memory_maintenance` (
	`id` text PRIMARY KEY NOT NULL,
	`last_reviewed_at` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_notion_links` (
	`memory_id` text PRIMARY KEY NOT NULL,
	`notion_page_id` text NOT NULL,
	`notion_block_id` text,
	`source_id` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

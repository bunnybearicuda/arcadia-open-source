CREATE TABLE `memory_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`companion_id` text NOT NULL,
	`filename` text NOT NULL,
	`media_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` integer DEFAULT 0 NOT NULL,
	`storage_key` text NOT NULL,
	`total_parts` integer DEFAULT 1 NOT NULL,
	`completed_parts` integer DEFAULT 0 NOT NULL,
	`character_count` integer DEFAULT 0 NOT NULL,
	`imported_count` integer DEFAULT 0 NOT NULL,
	`shared_count` integer DEFAULT 0 NOT NULL,
	`private_count` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);

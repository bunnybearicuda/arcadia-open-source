ALTER TABLE `companions` ADD `identity_source` text DEFAULT 'custom' NOT NULL;--> statement-breakpoint
ALTER TABLE `companions` ADD `custom_instructions` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companions` ADD `identity_file_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `companions` ADD `identity_file_content` text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE `companions`
SET `custom_instructions` = `identity`
WHERE `custom_instructions` = '' AND `identity` != '';

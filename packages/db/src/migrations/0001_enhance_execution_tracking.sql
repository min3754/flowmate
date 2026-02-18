-- Add model column for per-execution model tracking
ALTER TABLE `executions` ADD `model` text;--> statement-breakpoint
-- Split tokens_used JSON into individual queryable columns
ALTER TABLE `executions` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `executions` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `executions` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `executions` ADD `cache_write_tokens` integer;--> statement-breakpoint
-- Migrate existing JSON data to new columns
UPDATE `executions` SET
	`input_tokens` = json_extract(`tokens_used`, '$.input'),
	`output_tokens` = json_extract(`tokens_used`, '$.output'),
	`cache_read_tokens` = json_extract(`tokens_used`, '$.cacheRead'),
	`cache_write_tokens` = json_extract(`tokens_used`, '$.cacheWrite')
WHERE `tokens_used` IS NOT NULL;--> statement-breakpoint
-- Drop the old JSON column (SQLite 3.35.0+)
ALTER TABLE `executions` DROP COLUMN `tokens_used`;--> statement-breakpoint
-- Performance indexes on executions
CREATE INDEX `exec_conversation_idx` ON `executions` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `exec_status_idx` ON `executions` (`status`);--> statement-breakpoint
CREATE INDEX `exec_started_at_idx` ON `executions` (`started_at`);--> statement-breakpoint
-- Composite index for conversation history queries
CREATE INDEX `msg_conversation_created_idx` ON `messages` (`conversation_id`,`created_at`);

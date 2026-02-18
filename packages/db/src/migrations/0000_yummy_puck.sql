CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`channel_id` text NOT NULL,
	`thread_ts` text NOT NULL,
	`user_id` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conv_channel_thread_idx` ON `conversations` (`channel_id`,`thread_ts`);--> statement-breakpoint
CREATE TABLE `cost_summary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`total_cost_usd` real DEFAULT 0 NOT NULL,
	`total_executions` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cost_summary_date_unique` ON `cost_summary` (`date`);--> statement-breakpoint
CREATE TABLE `executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`container_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`prompt` text NOT NULL,
	`result_text` text,
	`error_message` text,
	`cost_usd` real,
	`tokens_used` text,
	`duration_ms` integer,
	`num_turns` integer,
	`started_at` text,
	`finished_at` text,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`slack_ts` text,
	`execution_id` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`execution_id`) REFERENCES `executions`(`id`) ON UPDATE no action ON DELETE no action
);

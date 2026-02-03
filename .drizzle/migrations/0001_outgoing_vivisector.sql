CREATE TABLE `user_book_preferences` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`progress_sync_enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_book_preferences_user_book_unique` ON `user_book_preferences` (`user_id`,`book_id`);--> statement-breakpoint
CREATE INDEX `user_book_preferences_user_idx` ON `user_book_preferences` (`user_id`);--> statement-breakpoint
CREATE TABLE `user_book_progress_log` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`progress_percent` real NOT NULL,
	`page_number` integer,
	`location` text,
	`source` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_book_progress_log_user_book_idx` ON `user_book_progress_log` (`user_id`,`book_id`);--> statement-breakpoint
CREATE INDEX `user_book_progress_log_user_book_occurred_idx` ON `user_book_progress_log` (`user_id`,`book_id`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `user_book_status` ADD `started_at` integer;--> statement-breakpoint
ALTER TABLE `user_book_status` ADD `finished_at` integer;--> statement-breakpoint
ALTER TABLE `user_book_status` ADD `dnf_at` integer;--> statement-breakpoint
ALTER TABLE `user_book_status` ADD `tbr_rank` integer;
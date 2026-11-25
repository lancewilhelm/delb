CREATE TABLE `user_book_reviews` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`text` text NOT NULL,
	`contains_spoilers` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_book_reviews_book_idx` ON `user_book_reviews` (`book_id`);--> statement-breakpoint
CREATE INDEX `book_notes_user_book_idx` ON `book_notes` (`user_id`,`book_id`);

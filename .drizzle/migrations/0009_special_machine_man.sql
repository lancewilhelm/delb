CREATE TABLE `user_bookshelves` (
	`user_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`arrangement` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

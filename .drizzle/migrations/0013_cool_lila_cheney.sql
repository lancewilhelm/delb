CREATE TABLE `personal_shelf_books` (
	`shelf_id` text NOT NULL,
	`book_id` text NOT NULL,
	`placement` text,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`shelf_id`, `book_id`),
	FOREIGN KEY (`shelf_id`) REFERENCES `personal_shelves`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_shelf_books_book_idx` ON `personal_shelf_books` (`book_id`);--> statement-breakpoint
CREATE TABLE `personal_shelves` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`geometry` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `personal_shelves_owner_idx` ON `personal_shelves` (`owner_id`);
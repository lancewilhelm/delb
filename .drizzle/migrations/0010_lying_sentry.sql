CREATE TABLE `book_spines` (
	`book_id` text PRIMARY KEY NOT NULL,
	`original_base64` text NOT NULL,
	`original_type` text NOT NULL,
	`image_base64` text NOT NULL,
	`edits` text NOT NULL,
	`revision` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);

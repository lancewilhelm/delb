ALTER TABLE `book_spines` ADD `image_path` text DEFAULT '' NOT NULL;
--> statement-breakpoint
ALTER TABLE `book_spines` ADD `original_path` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `book_mini_covers` (
	`book_id` text PRIMARY KEY NOT NULL,
	`spine_image_path` text DEFAULT '' NOT NULL,
	`spine_source_path` text DEFAULT '' NOT NULL,
	`spine_original_type` text DEFAULT '' NOT NULL,
	`spine_edits` text DEFAULT '' NOT NULL,
	`spine_revision` text DEFAULT '' NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);

ALTER TABLE `books` ADD `has_physical_copy` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `books` ADD `has_audiobook_copy` integer DEFAULT false NOT NULL;
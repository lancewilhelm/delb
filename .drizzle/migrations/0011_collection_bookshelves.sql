CREATE TABLE `book_shelf_dimensions` (
	`book_id` text PRIMARY KEY NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`manual_width` integer NOT NULL,
	`manual_height` integer NOT NULL,
	`source_pages` integer,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `collection_bookshelves` (
	`collection_id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`arrangement` text NOT NULL,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `book_shelf_dimensions` (`book_id`, `width`, `height`, `manual_width`, `manual_height`, `source_pages`)
SELECT `id`,
  CASE WHEN typeof(`pages`) = 'integer' AND `pages` BETWEEN 1 AND 1000000 THEN CAST(max(22, min(55, round(20 + `pages` / 25.0))) AS INTEGER) ELSE 32 END,
  180 + ((random() & 9223372036854775807) % 41), 0, 0,
  CASE WHEN typeof(`pages`) = 'integer' AND `pages` BETWEEN 0 AND 1000000 THEN `pages` ELSE NULL END
FROM `books`;
--> statement-breakpoint
CREATE TRIGGER `books_initialize_shelf_dimensions`
AFTER INSERT ON `books`
BEGIN
  INSERT INTO `book_shelf_dimensions` (`book_id`, `width`, `height`, `manual_width`, `manual_height`, `source_pages`)
  VALUES (
    NEW.`id`,
    CASE WHEN typeof(NEW.`pages`) = 'integer' AND NEW.`pages` BETWEEN 1 AND 1000000 THEN CAST(max(22, min(55, round(20 + NEW.`pages` / 25.0))) AS INTEGER) ELSE 32 END,
    180 + ((random() & 9223372036854775807) % 41), 0, 0,
    CASE WHEN typeof(NEW.`pages`) = 'integer' AND NEW.`pages` BETWEEN 0 AND 1000000 THEN NEW.`pages` ELSE NULL END
  );
END;

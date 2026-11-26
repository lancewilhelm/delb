CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `authors` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_name` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `book_authors` (
	`book_id` text NOT NULL,
	`author_id` text NOT NULL,
	`position` integer,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_files` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`format` text NOT NULL,
	`relative_path` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_identifiers` (
	`book_id` text NOT NULL,
	`type` text NOT NULL,
	`value` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_ratings` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`rating` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_tags` (
	`book_id` text NOT NULL,
	`tag_id` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `books` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`sort_title` text DEFAULT '' NOT NULL,
	`calibre_book_id` integer,
	`description` text,
	`published` text,
	`published_at` integer,
	`language` text,
	`pages` integer,
	`cover_image_path` text,
	`publisher_id` text,
	`series_id` text,
	`series_index` real,
	`created_by_user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL, added_by_user_id text REFERENCES users(id) ON DELETE SET NULL, added_at integer NOT NULL DEFAULT 0, `has_physical_copy` integer DEFAULT false NOT NULL, `has_audiobook_copy` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`publisher_id`) REFERENCES `publishers`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `global_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `global_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `publishers` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `series` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_book_reading_position` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`location` text NOT NULL,
	`progress` real,
	`updated_at` integer NOT NULL, `client_session_id` text, `client_sequence` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_book_status` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`status` text NOT NULL,
	`updated_at` integer NOT NULL, `started_at` integer, `finished_at` integer, `dnf_at` integer, `tbr_rank` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_settings` (
	`user_id` text PRIMARY KEY NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`role` text NOT NULL,
	`banned` integer,
	`ban_reason` text,
	`ban_expires` integer
);
--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `user_book_preferences` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`progress_sync_enabled` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `storage_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`book_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_book_rationale` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `book_spines` (
	`book_id` text PRIMARY KEY NOT NULL,
	`original_base64` text NOT NULL,
	`original_type` text NOT NULL,
	`image_base64` text NOT NULL,
	`edits` text NOT NULL,
	`revision` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `personal_shelves` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `codex_image_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`state` text NOT NULL,
	`encrypted_tokens` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `shared_codex_image_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`state` text NOT NULL,
	`encrypted_tokens` text
);
--> statement-breakpoint
CREATE TABLE `mcp_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`digest` text NOT NULL,
	`can_write` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL, `can_edit_metadata` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
CREATE TABLE `genres` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `book_genres` (
	`book_id` text NOT NULL,
	`genre_id` text NOT NULL,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`genre_id`) REFERENCES `genres`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_tag_rules` (
	`user_id` text NOT NULL,
	`tag_id` text NOT NULL,
	`mode` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `tag_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT `user_tag_rules_mode` CHECK(`mode` IN ('allow', 'block'))
);
--> statement-breakpoint
CREATE TABLE "bookshelf_layouts" (
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`layout` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_kind`, `scope_id`),
	CONSTRAINT `bookshelf_layouts_scope_kind` CHECK(`scope_kind` IN ('library', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "shelf_picture_assets" (
	`id` text PRIMARY KEY NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`image_base64` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`unused_since` integer,
	CONSTRAINT `shelf_picture_assets_scope_kind` CHECK(`scope_kind` IN ('library', 'personal'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `authors_name_unique` ON `authors` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_authors_book_id_author_id_unique` ON `book_authors` (`book_id`,`author_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_files_book_id_relative_path_unique` ON `book_files` (`book_id`,`relative_path`);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_identifiers_book_id_type_unique` ON `book_identifiers` (`book_id`,`type`);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_ratings_user_book_unique` ON `book_ratings` (`user_id`,`book_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_tags_book_id_tag_id_unique` ON `book_tags` (`book_id`,`tag_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `books_calibre_book_id_unique` ON `books` (`calibre_book_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `publishers_name_unique` ON `publishers` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `series_name_unique` ON `series` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_book_reading_position_user_book_unique` ON `user_book_reading_position` (`user_id`,`book_id`);
--> statement-breakpoint
CREATE INDEX `user_book_reading_position_user_idx` ON `user_book_reading_position` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_book_status_user_book_unique` ON `user_book_status` (`user_id`,`book_id`);
--> statement-breakpoint
CREATE INDEX `user_book_status_user_status_idx` ON `user_book_status` (`user_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_settings_user_id_unique` ON `user_settings` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_book_preferences_user_book_unique` ON `user_book_preferences` (`user_id`,`book_id`);
--> statement-breakpoint
CREATE INDEX `user_book_preferences_user_idx` ON `user_book_preferences` (`user_id`);
--> statement-breakpoint
CREATE INDEX `user_book_progress_log_user_book_idx` ON `user_book_progress_log` (`user_id`,`book_id`);
--> statement-breakpoint
CREATE INDEX `user_book_progress_log_user_book_occurred_idx` ON `user_book_progress_log` (`user_id`,`book_id`,`occurred_at`);
--> statement-breakpoint
CREATE INDEX `book_spines_book_revision_idx` ON `book_spines` (`book_id`,`revision`);
--> statement-breakpoint
CREATE INDEX `personal_shelf_books_book_idx` ON `personal_shelf_books` (`book_id`);
--> statement-breakpoint
CREATE INDEX `personal_shelves_owner_idx` ON `personal_shelves` (`owner_id`);
--> statement-breakpoint
CREATE INDEX `user_book_reviews_book_idx` ON `user_book_reviews` (`book_id`);
--> statement-breakpoint
CREATE INDEX `book_notes_user_book_idx` ON `book_notes` (`user_id`,`book_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `genres_name_unique` ON `genres` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `book_genres_book_id_genre_id_unique` ON `book_genres` (`book_id`,`genre_id`);
--> statement-breakpoint
CREATE INDEX `user_tag_rules_user_mode_idx` ON `user_tag_rules` (`user_id`, `mode`);
--> statement-breakpoint
CREATE INDEX `shelf_picture_assets_scope_idx` ON `shelf_picture_assets` (`scope_kind`, `scope_id`);
--> statement-breakpoint
CREATE VIEW `visible_books` AS
SELECT u.`id` AS `user_id`, b.`id` AS `book_id`
FROM `users` u
CROSS JOIN `books` b
WHERE u.`role` IN ('owner', 'admin')
	OR (
		NOT EXISTS (
			SELECT 1 FROM `book_tags` bt
			INNER JOIN `user_tag_rules` r ON r.`tag_id` = bt.`tag_id`
			WHERE bt.`book_id` = b.`id` AND r.`user_id` = u.`id` AND r.`mode` = 'block'
		)
		AND (
			NOT EXISTS (
				SELECT 1 FROM `user_tag_rules` r
				WHERE r.`user_id` = u.`id` AND r.`mode` = 'allow'
			)
			OR EXISTS (
				SELECT 1 FROM `book_tags` bt
				INNER JOIN `user_tag_rules` r ON r.`tag_id` = bt.`tag_id`
				WHERE bt.`book_id` = b.`id` AND r.`user_id` = u.`id` AND r.`mode` = 'allow'
			)
		)
	);
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

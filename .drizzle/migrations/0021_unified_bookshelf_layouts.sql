CREATE TABLE `bookshelf_layouts` (
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`layout` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_kind`, `scope_id`),
	CONSTRAINT `bookshelf_layouts_scope_kind` CHECK(`scope_kind` IN ('collection', 'personal'))
);
--> statement-breakpoint
INSERT INTO `bookshelf_layouts` (`scope_kind`, `scope_id`, `revision`, `layout`, `updated_at`)
SELECT 'collection', `collection_id`, `revision`, `arrangement`, unixepoch() * 1000
FROM `collection_bookshelves`;
--> statement-breakpoint
INSERT INTO `bookshelf_layouts` (`scope_kind`, `scope_id`, `revision`, `layout`, `updated_at`)
SELECT 'personal', `id`, `revision`, `geometry`, `created_at`
FROM `personal_shelves`
WHERE `revision` > 0
   OR EXISTS (SELECT 1 FROM `personal_shelf_books` psb WHERE psb.`shelf_id` = `personal_shelves`.`id` AND psb.`placement` IS NOT NULL)
   OR EXISTS (SELECT 1 FROM `shelf_picture_assets` spa WHERE spa.`personal_shelf_id` = `personal_shelves`.`id`);
--> statement-breakpoint
CREATE TABLE `shelf_picture_assets_new` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`image_base64` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`unused_since` integer,
	CONSTRAINT `shelf_picture_assets_scope_kind` CHECK(`scope_kind` IN ('collection', 'personal'))
);
--> statement-breakpoint
INSERT INTO `shelf_picture_assets_new` (`id`, `scope_kind`, `scope_id`, `image_base64`, `bytes`, `created_at`, `unused_since`)
SELECT
	`id`,
	CASE WHEN `collection_id` IS NOT NULL THEN 'collection' ELSE 'personal' END,
	COALESCE(`collection_id`, `personal_shelf_id`),
	`image_base64`,
	`bytes`,
	`created_at`,
	`unused_since`
FROM `shelf_picture_assets`;
--> statement-breakpoint
DROP TABLE `shelf_picture_assets`;
--> statement-breakpoint
ALTER TABLE `shelf_picture_assets_new` RENAME TO `shelf_picture_assets`;
--> statement-breakpoint
CREATE INDEX `shelf_picture_assets_scope_idx` ON `shelf_picture_assets` (`scope_kind`, `scope_id`);
--> statement-breakpoint
ALTER TABLE `personal_shelves` DROP COLUMN `revision`;
--> statement-breakpoint
ALTER TABLE `personal_shelves` DROP COLUMN `geometry`;
--> statement-breakpoint
DROP TABLE `collection_bookshelves`;
--> statement-breakpoint
DROP TABLE `user_bookshelves`;

UPDATE `users` SET `role` = CASE
	WHEN instr(',' || replace(`role`, ' ', '') || ',', ',owner,') > 0 THEN 'owner'
	WHEN instr(',' || replace(`role`, ' ', '') || ',', ',admin,') > 0 THEN 'admin'
	WHEN EXISTS (
		SELECT 1 FROM `collection_members` cm
		WHERE cm.`user_id` = `users`.`id` AND cm.`role` IN ('owner', 'editor')
	) THEN 'editor'
	ELSE 'reader'
END;
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
CREATE INDEX `user_tag_rules_user_mode_idx` ON `user_tag_rules` (`user_id`, `mode`);
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
CREATE TABLE `bookshelf_layouts_new` (
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	`layout` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`scope_kind`, `scope_id`),
	CONSTRAINT `bookshelf_layouts_scope_kind` CHECK(`scope_kind` IN ('library', 'personal'))
);
--> statement-breakpoint
INSERT INTO `bookshelf_layouts_new` (`scope_kind`, `scope_id`, `revision`, `layout`, `updated_at`)
SELECT 'personal', `scope_id`, `revision`, `layout`, `updated_at`
FROM `bookshelf_layouts`
WHERE `scope_kind` = 'personal';
--> statement-breakpoint
INSERT INTO `bookshelf_layouts_new` (`scope_kind`, `scope_id`, `revision`, `layout`, `updated_at`)
SELECT 'library', 'main', bl.`revision`, bl.`layout`, bl.`updated_at`
FROM `bookshelf_layouts` bl
LEFT JOIN `collections` c ON c.`id` = bl.`scope_id`
WHERE bl.`scope_kind` = 'collection'
ORDER BY COALESCE(c.`is_default`, 0) DESC, bl.`updated_at` DESC, bl.`scope_id`
LIMIT 1;
--> statement-breakpoint
DROP TABLE `bookshelf_layouts`;
--> statement-breakpoint
ALTER TABLE `bookshelf_layouts_new` RENAME TO `bookshelf_layouts`;
--> statement-breakpoint
CREATE TABLE `shelf_picture_assets_new` (
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
INSERT INTO `shelf_picture_assets_new` (`id`, `scope_kind`, `scope_id`, `image_base64`, `bytes`, `created_at`, `unused_since`)
SELECT
	`id`,
	CASE WHEN `scope_kind` = 'collection' THEN 'library' ELSE 'personal' END,
	CASE WHEN `scope_kind` = 'collection' THEN 'main' ELSE `scope_id` END,
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
DROP TRIGGER IF EXISTS `tbr_membership_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tbr_membership_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tbr_book_move`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `books_require_collection_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `books_require_collection_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `collections_create_owner`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `collections_transfer_owner`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `members_keep_owner`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `members_owner_role_update`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `members_owner_role_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `users_keep_collections`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `collections_delete_empty`;
--> statement-breakpoint
DROP VIEW IF EXISTS `collection_books`;
--> statement-breakpoint
DROP INDEX IF EXISTS `books_collection_idx`;
--> statement-breakpoint
ALTER TABLE `books` DROP COLUMN `collection_id`;
--> statement-breakpoint
DROP TABLE IF EXISTS `legacy_collection_books`;
--> statement-breakpoint
DROP TABLE `collection_members`;
--> statement-breakpoint
DROP TABLE `collections`;
--> statement-breakpoint
DELETE FROM `system_state` WHERE `key` IN ('collections-model', 'collection-migration-plan');
--> statement-breakpoint
UPDATE `global_settings`
SET `settings` = json_remove(`settings`, '$.dropbox.targetCollectionId', '$.dropbox.additionalCollectionIds')
WHERE json_valid(`settings`) AND json_type(`settings`, '$.dropbox') = 'object';

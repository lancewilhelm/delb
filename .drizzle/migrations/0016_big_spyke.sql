CREATE TABLE `shelf_picture_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`collection_id` text,
	`personal_shelf_id` text,
	`image_base64` text NOT NULL,
	`bytes` integer NOT NULL,
	`created_at` integer NOT NULL,
	`unused_since` integer,
	FOREIGN KEY (`collection_id`) REFERENCES `collections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`personal_shelf_id`) REFERENCES `personal_shelves`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "shelf_picture_assets_scope" CHECK(("shelf_picture_assets"."collection_id" IS NULL) <> ("shelf_picture_assets"."personal_shelf_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX `shelf_picture_assets_collection_idx` ON `shelf_picture_assets` (`collection_id`);--> statement-breakpoint
CREATE INDEX `shelf_picture_assets_personal_idx` ON `shelf_picture_assets` (`personal_shelf_id`);
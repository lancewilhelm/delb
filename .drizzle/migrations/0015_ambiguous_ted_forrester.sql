CREATE TABLE `shared_codex_image_connection` (
	`id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`state` text NOT NULL,
	`encrypted_tokens` text
);

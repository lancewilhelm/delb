CREATE TABLE `codex_image_connections` (
	`user_id` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`state` text NOT NULL,
	`encrypted_tokens` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);

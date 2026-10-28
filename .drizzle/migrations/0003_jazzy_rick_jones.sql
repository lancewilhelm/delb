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
INSERT INTO system_state (key, value)
SELECT 'owner-bootstrap', 'complete'
WHERE EXISTS (SELECT 1 FROM users);

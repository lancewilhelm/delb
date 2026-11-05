CREATE TABLE `user_book_rationale` (
	`user_id` text NOT NULL,
	`book_id` text NOT NULL,
	`text` text NOT NULL,
	PRIMARY KEY(`user_id`, `book_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`book_id`) REFERENCES `books`(`id`) ON UPDATE no action ON DELETE cascade
);

--> statement-breakpoint
-- Observe access changes in the same transaction as every membership/link mutation,
-- including cascades. A restored book has a NULL rank and joins the end. UPDATE FROM
-- materializes the ranked sequence before writes, preserving order while closing gaps.
UPDATE user_book_status SET tbr_rank = NULL
WHERE status = 'to_be_read' AND 1 AND NOT EXISTS (
  SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
  WHERE cb.book_id = user_book_status.book_id AND cm.user_id = user_book_status.user_id
);
--> statement-breakpoint
UPDATE user_book_status SET tbr_rank = ranked.position
FROM (
  SELECT s.user_id, s.book_id,
    row_number() OVER (PARTITION BY s.user_id ORDER BY s.tbr_rank IS NULL, s.tbr_rank, s.book_id) AS position
  FROM user_book_status s
  WHERE s.status = 'to_be_read' AND 1 AND EXISTS (
    SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
    WHERE cb.book_id = s.book_id AND cm.user_id = s.user_id
  )
) AS ranked
WHERE user_book_status.user_id = ranked.user_id AND user_book_status.book_id = ranked.book_id;

--> statement-breakpoint
CREATE TRIGGER tbr_membership_insert AFTER INSERT ON collection_members
BEGIN
UPDATE user_book_status SET tbr_rank = NULL
WHERE status = 'to_be_read' AND user_book_status.user_id = NEW.user_id AND NOT EXISTS (
  SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
  WHERE cb.book_id = user_book_status.book_id AND cm.user_id = user_book_status.user_id
);
UPDATE user_book_status SET tbr_rank = ranked.position
FROM (
  SELECT s.user_id, s.book_id,
    row_number() OVER (PARTITION BY s.user_id ORDER BY s.tbr_rank IS NULL, s.tbr_rank, s.book_id) AS position
  FROM user_book_status s
  WHERE s.status = 'to_be_read' AND s.user_id = NEW.user_id AND EXISTS (
    SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
    WHERE cb.book_id = s.book_id AND cm.user_id = s.user_id
  )
) AS ranked
WHERE user_book_status.user_id = ranked.user_id AND user_book_status.book_id = ranked.book_id;
END;

--> statement-breakpoint
CREATE TRIGGER tbr_membership_delete AFTER DELETE ON collection_members
BEGIN
UPDATE user_book_status SET tbr_rank = NULL
WHERE status = 'to_be_read' AND user_book_status.user_id = OLD.user_id AND NOT EXISTS (
  SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
  WHERE cb.book_id = user_book_status.book_id AND cm.user_id = user_book_status.user_id
);
UPDATE user_book_status SET tbr_rank = ranked.position
FROM (
  SELECT s.user_id, s.book_id,
    row_number() OVER (PARTITION BY s.user_id ORDER BY s.tbr_rank IS NULL, s.tbr_rank, s.book_id) AS position
  FROM user_book_status s
  WHERE s.status = 'to_be_read' AND s.user_id = OLD.user_id AND EXISTS (
    SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
    WHERE cb.book_id = s.book_id AND cm.user_id = s.user_id
  )
) AS ranked
WHERE user_book_status.user_id = ranked.user_id AND user_book_status.book_id = ranked.book_id;
END;

--> statement-breakpoint
CREATE TRIGGER tbr_link_insert AFTER INSERT ON collection_books
BEGIN
UPDATE user_book_status SET tbr_rank = NULL
WHERE status = 'to_be_read' AND user_book_status.user_id IN (SELECT user_id FROM collection_members WHERE collection_id = NEW.collection_id) AND NOT EXISTS (
  SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
  WHERE cb.book_id = user_book_status.book_id AND cm.user_id = user_book_status.user_id
);
UPDATE user_book_status SET tbr_rank = ranked.position
FROM (
  SELECT s.user_id, s.book_id,
    row_number() OVER (PARTITION BY s.user_id ORDER BY s.tbr_rank IS NULL, s.tbr_rank, s.book_id) AS position
  FROM user_book_status s
  WHERE s.status = 'to_be_read' AND s.user_id IN (SELECT user_id FROM collection_members WHERE collection_id = NEW.collection_id) AND EXISTS (
    SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
    WHERE cb.book_id = s.book_id AND cm.user_id = s.user_id
  )
) AS ranked
WHERE user_book_status.user_id = ranked.user_id AND user_book_status.book_id = ranked.book_id;
END;

--> statement-breakpoint
CREATE TRIGGER tbr_link_delete AFTER DELETE ON collection_books
BEGIN
UPDATE user_book_status SET tbr_rank = NULL
WHERE status = 'to_be_read' AND user_book_status.user_id IN (SELECT user_id FROM collection_members WHERE collection_id = OLD.collection_id) AND NOT EXISTS (
  SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
  WHERE cb.book_id = user_book_status.book_id AND cm.user_id = user_book_status.user_id
);
UPDATE user_book_status SET tbr_rank = ranked.position
FROM (
  SELECT s.user_id, s.book_id,
    row_number() OVER (PARTITION BY s.user_id ORDER BY s.tbr_rank IS NULL, s.tbr_rank, s.book_id) AS position
  FROM user_book_status s
  WHERE s.status = 'to_be_read' AND s.user_id IN (SELECT user_id FROM collection_members WHERE collection_id = OLD.collection_id) AND EXISTS (
    SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
    WHERE cb.book_id = s.book_id AND cm.user_id = s.user_id
  )
) AS ranked
WHERE user_book_status.user_id = ranked.user_id AND user_book_status.book_id = ranked.book_id;
END;


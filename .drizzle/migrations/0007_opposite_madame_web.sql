-- Stage legacy data without changing access or copying files. The admin preview/apply completes the data migration.
DROP TRIGGER IF EXISTS tbr_link_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tbr_link_delete;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tbr_membership_insert;
--> statement-breakpoint
DROP TRIGGER IF EXISTS tbr_membership_delete;
--> statement-breakpoint
ALTER TABLE collection_books RENAME TO legacy_collection_books;
--> statement-breakpoint
ALTER TABLE books ADD collection_id text REFERENCES collections(id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE books ADD added_by_user_id text REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE books ADD added_at integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE collections ADD is_default integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX collections_single_default ON collections(is_default) WHERE is_default = 1;
--> statement-breakpoint
CREATE INDEX books_collection_idx ON books(collection_id);
--> statement-breakpoint
CREATE VIEW collection_books AS SELECT collection_id, id AS book_id, added_by_user_id, added_at FROM books;
--> statement-breakpoint
INSERT INTO system_state(key,value) SELECT 'collections-model', CASE WHEN EXISTS(SELECT 1 FROM users) OR EXISTS(SELECT 1 FROM books) THEN 'pending' ELSE 'exclusive' END;
--> statement-breakpoint
CREATE TRIGGER books_require_collection_insert BEFORE INSERT ON books
WHEN NEW.collection_id IS NULL
BEGIN SELECT RAISE(ABORT, 'A book requires one collection'); END;
--> statement-breakpoint
CREATE TRIGGER books_require_collection_update BEFORE UPDATE OF collection_id ON books
WHEN NEW.collection_id IS NULL
BEGIN SELECT RAISE(ABORT, 'A book requires one collection'); END;
--> statement-breakpoint
CREATE TRIGGER collections_create_owner AFTER INSERT ON collections
BEGIN INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES(NEW.id,NEW.owner_user_id,'owner',NEW.created_at); END;
--> statement-breakpoint
CREATE TRIGGER collections_transfer_owner AFTER UPDATE OF owner_user_id ON collections
WHEN NEW.owner_user_id != OLD.owner_user_id
BEGIN
UPDATE collection_members SET role='editor' WHERE collection_id=NEW.id AND user_id=OLD.owner_user_id;
INSERT INTO collection_members(collection_id,user_id,role,created_at) VALUES(NEW.id,NEW.owner_user_id,'owner',NEW.updated_at)
ON CONFLICT(collection_id,user_id) DO UPDATE SET role='owner';
END;
--> statement-breakpoint
CREATE TRIGGER members_keep_owner BEFORE DELETE ON collection_members
WHEN EXISTS(SELECT 1 FROM collections WHERE id=OLD.collection_id AND owner_user_id=OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'Transfer collection ownership before removing the owner'); END;
--> statement-breakpoint
CREATE TRIGGER members_owner_role_update BEFORE UPDATE OF role,user_id,collection_id ON collection_members
WHEN NEW.role NOT IN ('owner','editor','viewer') OR (NEW.role='owner') != EXISTS(SELECT 1 FROM collections WHERE id=NEW.collection_id AND owner_user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Use collection ownership transfer'); END;
--> statement-breakpoint
CREATE TRIGGER members_owner_role_insert BEFORE INSERT ON collection_members
WHEN NEW.role NOT IN ('owner','editor','viewer') OR (NEW.role='owner') != EXISTS(SELECT 1 FROM collections WHERE id=NEW.collection_id AND owner_user_id=NEW.user_id)
BEGIN SELECT RAISE(ABORT, 'Use collection ownership transfer'); END;
--> statement-breakpoint
CREATE TRIGGER users_keep_collections BEFORE DELETE ON users
WHEN EXISTS(SELECT 1 FROM collections WHERE owner_user_id=OLD.id)
BEGIN SELECT RAISE(ABORT, 'Transfer or delete owned collections before deleting this account'); END;
--> statement-breakpoint
CREATE TRIGGER collections_delete_empty BEFORE DELETE ON collections
WHEN OLD.is_default=1 OR EXISTS(SELECT 1 FROM books WHERE collection_id=OLD.id) OR
(EXISTS(SELECT 1 FROM system_state WHERE key='collections-model' AND value!='exclusive') AND EXISTS(SELECT 1 FROM legacy_collection_books WHERE collection_id=OLD.id))
BEGIN SELECT RAISE(ABORT, 'Choose another default and empty the collection before deletion'); END;
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
CREATE TRIGGER tbr_book_move AFTER UPDATE OF collection_id ON books
BEGIN
UPDATE user_book_status SET tbr_rank = NULL
WHERE status = 'to_be_read' AND user_book_status.user_id IN (SELECT user_id FROM collection_members WHERE collection_id IN (NEW.collection_id, OLD.collection_id)) AND NOT EXISTS (
  SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
  WHERE cb.book_id = user_book_status.book_id AND cm.user_id = user_book_status.user_id
);
UPDATE user_book_status SET tbr_rank = ranked.position
FROM (
  SELECT s.user_id, s.book_id,
    row_number() OVER (PARTITION BY s.user_id ORDER BY s.tbr_rank IS NULL, s.tbr_rank, s.book_id) AS position
  FROM user_book_status s
  WHERE s.status = 'to_be_read' AND s.user_id IN (SELECT user_id FROM collection_members WHERE collection_id IN (NEW.collection_id, OLD.collection_id)) AND EXISTS (
    SELECT 1 FROM collection_books cb JOIN collection_members cm ON cm.collection_id = cb.collection_id
    WHERE cb.book_id = s.book_id AND cm.user_id = s.user_id
  )
) AS ranked
WHERE user_book_status.user_id = ranked.user_id AND user_book_status.book_id = ranked.book_id;
END;

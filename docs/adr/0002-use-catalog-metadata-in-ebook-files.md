# Use Delb's catalog metadata in ebook files

Delb's catalog metadata is authoritative for converted ebooks, including their covers. Saving catalog metadata automatically starts embedded metadata updates, without a separate write-to-file action. Catalog saves succeed independently of file updates, so a failed file update does not block catalog editing or revert a saved edit.

Automatic metadata updates include original conversion sources wherever Delb supports writing the format. Conversion itself preserves its source bytes. Later metadata edits may change the source's embedded metadata.

Pending and failed file updates remain visible and retryable, including after a restart. The catalog and ebook files may temporarily differ, and Delb must show their synchronization status accurately.

Metadata writing starts with EPUB. The eventual target covers all four currently accepted formats: EPUB, MOBI, AZW3, and PDF. Delb distinguishes formats it cannot yet rewrite from supported formats whose updates failed.

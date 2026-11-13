# Add books

Sign in before adding a book. You need owner or editor access to the collection you select as a target.

Open **Add book** in the header. The dialog has **Upload files**, **By metadata**, and **Manual entry** modes. Choose one destination. Delb preselects the active editable collection or the editable shared default. If neither applies, choose or create a collection.

## Upload ebook files

1. Select **Upload files**.
2. Drop files into the upload area, or browse for EPUB, PDF, MOBI, or AZW3 files.
3. Check the destination collection.
4. Select **Upload**.

Delb extracts the available metadata and stores the files in its managed library. A successful result appears in the dialog and the book becomes available in the selected collection. Extraction varies by format; review the details after import.

Uploads run sequentially in the dialog. Check each file's result when uploading several files. A successful HTTP response for a batch can still contain an individual file failure.

## Add a book from metadata

This mode needs outbound access to an enabled metadata provider. Google Books uses a public API. Hardcover requires an administrator-configured token.

1. Select **By metadata**.
2. Enter an ISBN, title, or author query.
3. Select **Add top result** to accept the best match, or **Search results** to choose a result.
4. Review the imported book details.

This creates a catalog entry, not a downloadable ebook. A downloaded cover does not count as an ebook file. The Add book flow imports the selected record as a whole. The editor's metadata search supports selecting individual fields.

To scan physical books, select **Mark as a physical copy** and **Keep open and refocus after each add**. Scan an ISBN with a barcode scanner that sends Enter, or type it and press Enter. Delb adds the top result and keeps the physical-copy option selected for the next book. The option resets when you close the dialog. It also applies when you choose a search result or resolve a duplicate; leaving it unchecked does not remove a mark from an existing book.

## Enter a book manually

1. Select **Manual entry**.
2. Check the destination collection and open the blank editor.
3. Enter at least a title and an author.
4. Select **Create**.

The entry is created when you select Create. The dialog describes this as saving, but the blank editor's button is labeled Create. Leaving the blank editor before submission does not create a book. A manual entry can represent a physical book without an ebook file.

## Resolve a possible duplicate

Review visible matches before creating an independent entry. A match in another collection offers an independent entry or cancellation. Replacement requires owner or editor access and stays in the existing collection. Moving is a separate confirmed action.

Each entry belongs to one collection. Independent entries may represent the same title. Administrative health checks report possible duplicates without merging or deleting them.

If collections fail to load or a selected target is no longer editable, correct the target selection before retrying. For storage errors after an interrupted operation, use the [storage recovery guide](../hosting/storage-recovery.md).

Continue with [finding books](find-books.md). See [ingestion request flows](../developing/core-workflows.md#add-a-book) and the [metadata reference](../developing/reference/metadata.md) for backend behavior.

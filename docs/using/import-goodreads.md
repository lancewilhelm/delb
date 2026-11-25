# Import from Goodreads

Delb can import your Goodreads library: reading statuses, finish dates, the To be read order, ratings, reviews, private notes, and shelves. The import affects only your account. It shows what will change before it writes anything.

## Export your Goodreads library

1. In Goodreads, open **My Books**.
2. Select **Import and export**, then **Export Library**.
3. Download the CSV file when Goodreads finishes preparing it.

Goodreads has no public API, so the export file is the only source that Delb can read.

## Preview the import

1. In Delb, open **Settings → Import**.
2. Choose the Goodreads CSV file and select **Preview import**.

Delb compares each Goodreads book with the books that you can see in Delb. It matches books in this order:

1. A Goodreads ID that an earlier import recorded.
2. The ISBN-13 or ISBN-10. Delb treats the two forms of an ISBN as the same number.
3. The title and authors. Delb removes the series suffix that Goodreads adds, such as "(The Stormlight Archive, #1)", and also tries the title without its subtitle.

A close title match is labeled **Likely match — confirm**. Each book has a **Delb book** menu. Use it to choose a different candidate, or choose **Not in Delb** to treat the book as missing.

## Choose what to import

- **What to import** turns statuses, ratings, reviews, private notes, and shelves on or off.
- **Goodreads shelves to Delb statuses** maps each Goodreads exclusive shelf to a Delb status. By default, `read` becomes Finished, `currently-reading` becomes Reading, and `to-read` becomes To be read. A custom shelf whose name suggests that you stopped reading, such as `did-not-finish`, becomes DNF. Other custom exclusive shelves set no status unless you choose one.
- **Shelves** lists your other Goodreads shelves. Each selected shelf becomes a personal Delb shelf. If you already have a shelf with the same name, Delb adds the books to it.

## Books that are not in Delb

Choose one of three options:

- **Skip them.** Only books that are already in Delb get reading data.
- **Create catalog entries from the Goodreads data.** Delb creates entries without ebook files. They include the title, authors, series, ISBNs, page count, publisher, and publication year. This option is fast, and the entries have no covers.
- **Create entries and look up metadata.** Delb also asks the configured metadata provider for each book and adds its description, cover, and other details when the result matches the title and author. This option is slower, and the provider can limit the request rate. A book without an acceptable result gets the Goodreads data.

New entries go into one collection. You can choose an existing collection that you can edit, or create a new private collection. Other members of the chosen collection can see the new entries. Your statuses, ratings, reviews, and notes stay private either way.

A Goodreads book that you mark as owned is also marked as a physical copy.

## Differences from your Delb data

A book that already has a status, rating, or review in Delb can disagree with Goodreads. Choose **Keep the Delb values** or **Use the Goodreads values** as the default. Then open the **Differences** filter to change individual books. Each book shows both versions.

Values that are missing in Delb are always filled in from Goodreads. Private notes are added unless the book already has an identical note.

## How dates and the queue are handled

- Goodreads exports only the most recent read date and no start dates. Delb leaves a missing date empty instead of filling in today's date. A start date that you recorded in Delb is kept when it is still earlier than the imported finish date.
- A finished book with a read date gets a 100% progress entry on that date.
- Books that join To be read keep their Goodreads queue order. They follow the books that are already in your Delb queue. Books without a Goodreads queue position follow, ordered by the date when you added them on Goodreads.
- Goodreads ratings of 1 to 5 stars become the same number of stars in Delb.
- Goodreads read counts are not imported, because Delb records one status per book.

## Run the import again

When an import finishes, Delb records the Goodreads ID on each matched book in a collection that you can edit. Entries that the import creates also carry their Goodreads ID. A later import matches these books directly, so it does not create duplicates. If an import stops partway, run it again with the same file.

See [read books and track progress](reading.md) for statuses, reviews, and notes after the import.

# Bookshelf spine revision lookup

On November 15, 2026, the deployed 804-book collection took 1.50 to 1.77 seconds to enter the bookshelf view across five runs. Warm page loads took 1.90 to 2.28 seconds across five runs. The bookshelf API returned HTTP 200 in every measured run. Its response dominated the wait. These numbers precede the index change.

The owner ran a read-only SQLite diagnostic inside the deployed container. Seven interleaved runs returned a median of 11.0 ms for the catalog rows and 13.4 ms with author names. Adding spine revisions raised the median to 1,096.3 ms. Adding the dimensions join produced a median of 1,089.1 ms. The diagnostic returned 804 rows for every query and did not report book data. It measured the database query, not the whole HTTP request.

The revision is stored in the same row as the original and edited artwork. The primary-key index finds each row, but reading the revision can require reading artwork data. The new index contains the book ID and revision. The bookshelf query names that index because SQLite selected the primary-key index when the covering index was available without a hint.

Run the synthetic comparison with:

```sh
node --no-warnings review/bookshelf-spine-index-benchmark.mjs
```

The comparison creates disposable SQLite databases with 804 books, 101 artwork rows, and two invented one-megabyte image strings per artwork row. Seven alternating runs returned the same IDs and revisions. On the development machine, the original query took 24.5 to 26.0 ms and the indexed query took 0.2 to 0.3 ms. The query plan confirms that the new query uses the covering index. The fixture uses local storage and does not measure the deployed host or actual artwork sizes.

The production build, isolated API tests, schema upgrade test, and 800-book browser fixture passed. The browser fixture used no artwork. Repeat the deployed measurements after the change is deployed before claiming an end-to-end improvement or that the shelf meets the one-second target.

# JavaScript ebook conversion feasibility

The tested JavaScript pipeline converts legacy MOBI and KF8/AZW3 into EPUB without Calibre or Python. Eight generated EPUBs pass EPUBCheck 5.4.0 with zero errors and warnings. Two protected inputs are rejected before conversion. This demonstrates a path for the agreed conversion scope, not general format coverage or a completed Delb feature.

## What the experiment runs

This directory is a standalone Node package. It does not change Delb's application dependencies, database, managed library, or APIs.

- A pinned [Foliate.js MOBI reader](https://github.com/johnfactotum/foliate-js/blob/78914aef4466eb960965702401634c2cb348e9b1/mobi.js) parses MOBI and KF8. Its upstream license is MIT, and the downloaded license stays with the cached source.
- JSDOM supplies the DOM APIs in Node. It does not execute book scripts or render the book.
- The experimental writer resolves Kindle links, packages resources with fflate, writes navigation and an EPUB manifest, and embeds test catalog metadata.
- Legacy presentation attributes and font elements become CSS. The writer also normalizes character-set declarations, document types, and empty document titles.
- The converter uses JavaScript dependencies only. Java is used solely by the separate development validator.

Downloads and hashes are locked in [downloads.json](downloads.json). Public test samples come from [libmobi's fixture collection](https://github.com/bfabiszewski/libmobi/tree/906274205c11944b628da1c553b255acb1af7c55/tests/samples) and [Project Gutenberg's Alice edition](https://www.gutenberg.org/ebooks/11). The test downloads existing books rather than invoking a book compiler.

## Evidence already obtained

The complete compact record is [evidence.json](evidence.json). The corpus covers:

- Legacy MOBI with PalmDOC compression and Windows-1252 text.
- KF8 with PalmDOC compression, HUFF/CDIC compression, and uncompressed text.
- Nested navigation, image resources, CSS, and font resources.
- A multimedia diagnostic, without a playback check.
- Two protected files, covering the fixture collection's version 1 and version 2 encryption cases.

Both Alice conversions preserve all 768 reference story paragraphs in order against the publisher's separately downloaded EPUB. Per-section text checks also compare parsed source and output text, preserving Unicode while normalizing whitespace. Binary resources remain byte-identical, source files remain unchanged, and all checked local links and navigation targets resolve. The generated files contain the overridden title, author, language, and test cover.

All eight emitted EPUBs pass the separate EPUBCheck run. The multimedia sample is diagnostic and is not part of the required ebook corpus. The output cover is deliberately a synthetic one-pixel PNG used to prove that catalog cover bytes take precedence.

### The parser needs a conversion adapter

The unmodified reader cannot resolve a KF8 target whose fragment contains only whitespace. The fragment index identifies its insertion parent, but the reader looks for an element inside the fragment itself.

The experiment adds a narrow fallback at fragment offset zero: use the index's recorded insertion target when no tagged target exists in the fragment. It leaves other unresolved targets as errors. The setup script checks the pinned source before generating a separate adapted module in the cache. It never edits the downloaded original.

With the original parser, the HUFF/CDIC, uncompressed, and multimedia samples reproduce the missing-anchor failure. With the adapter, their links resolve and their output passes both structural checks and EPUBCheck. The required corpus contains two of these failures; the third is the multimedia diagnostic.

## Reproduce the checks

Use Node 22.22.3 or a compatible newer runtime. Run these commands from the Delb repository root. The isolated package uses its own npm lockfile.

```sh
npm --prefix review/book-conversion ci --ignore-scripts
npm --prefix review/book-conversion run check
npm --prefix review/book-conversion run validate
```

The first run needs network access. Later runs reuse checksummed downloads in `.cache/`. The structural check should report eight successful conversions, reject both protected inputs, and exit zero. The formal validator should report zero errors for all eight EPUBs and exit zero.

The validator uses an available Java runtime. On Apple Silicon macOS, it can instead download a checksummed Temurin 21 JRE into this experiment's cache. It does not install Java system-wide. On other systems without Java, set `EPUBCHECK_JAVA` to a Java executable for this development check. Neither the converter nor Delb gains a Java dependency.

To reproduce the parser failure and refresh the compact evidence, run:

```sh
npm --prefix review/book-conversion run check:original
npm --prefix review/book-conversion run evidence
```

The original-parser command intentionally exits one and reports two required samples with gaps. Read `output/original-parser/report.json` for those failures. The evidence command expects the structural, original-parser, and validator reports from the commands above.

Generated EPUBs and reports stay under `output/`. Open `output/alice.azw3.epub` in an EPUB reader for a manual check. Expect the title **Delb conversion feasibility**, author **Delb metadata author**, and 16 navigation entries. Follow chapter links and inspect the text. This manual check has not been performed as part of the recorded evidence.

## What remains unproven

EPUB conformance and extracted-text checks do not establish visual fidelity in Delb's reader or on devices. The independent Alice reference has no interior illustrations. Image preservation evidence comes from the smaller libmobi fixtures, so an illustrated full-length book should be part of later acceptance testing.

This corpus does not establish support for fixed-layout books, dictionaries, malformed inputs, every compression variant, or arbitrary file sizes. The headless text approximation does not establish rendered spacing. The experiment has not exercised worker memory limits, cancellation, hostile files, or every protected-file variant.

Only title, author, language, and cover metadata are exercised here. Full EPUB metadata editing and writing MOBI, AZW3, or PDF metadata remain separate work.

## Consequences for the implementation plan

Proceed with an explicit conversion adapter and EPUB writer, with source hashes and format-specific fixtures as acceptance evidence. Treat the insertion-target fix and legacy markup normalization as required conversion behavior. Pin upstream source and preserve its license if it is reused.

Delb still needs the agreed application workflow: durable per-file metadata synchronization and conversion jobs, truthful status and retry controls, safe attachment or replacement of output files, and reading-position handling. Existing upload replacement removes other file records, and the reader lacks EPUB file identity in its saved positions. Those contracts must be addressed before integrating this converter.

The accepted product boundaries remain in the [conversion ADR](../../docs/adr/0001-independent-ebook-conversion-and-metadata.md), [metadata ADR](../../docs/adr/0002-use-catalog-metadata-in-ebook-files.md), and [reading-position ADR](../../docs/adr/0003-reset-reading-positions-on-epub-replacement.md).

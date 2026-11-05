# Keep ebook conversion and metadata editing independent of Calibre and Python

Delb's planned ebook format conversion and metadata editing will use independent JavaScript and TypeScript implementations. These features must never require Calibre or Python. This constraint takes precedence over matching Calibre's format coverage.

The first version operates on one selected book at a time. It includes metadata editing and format conversion, with conversion a major goal. Editing the book's text, chapter structure, and styling is outside this scope.

The first conversion inputs are unencrypted MOBI and AZW3, with EPUB as the output format. Protected inputs receive a clear unsupported-file explanation. PDF conversion is deferred. Conversion leaves its source file unchanged and attaches the generated EPUB to the same book entry.

Conversion continues when the user leaves the book page. Its progress, result, or failure remains available on that book's page, with an option to retry a failed conversion.

Converted EPUBs must preserve complete text, chapter order, images, links, and the table of contents wherever present. Fonts and pagination may change.

Replacing an existing EPUB requires explicit confirmation. Delb retains the existing file until the new conversion succeeds, so a failed conversion leaves the existing EPUB usable.

The [conversion feasibility check](../../review/book-conversion/README.md) records the initial JavaScript-only experiment and its limits. Its output is not an implementation of these Delb workflows.

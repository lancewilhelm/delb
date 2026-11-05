# Reset exact reading positions when replacing an EPUB

Delb currently stores an exact reading position per reader and book without identifying the EPUB file. Replacing that EPUB can invalidate the saved location. A successful EPUB replacement will clear exact reading positions for all of the book's readers while preserving their reading status and progress history.

The replacement confirmation explains this consequence. Failed conversions leave the existing EPUB and reading positions intact. Metadata-only updates must preserve reading positions.

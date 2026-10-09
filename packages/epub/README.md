# @delb/epub

Standards-aware EPUB inspection and cover editing for JavaScript and TypeScript.

```ts
import { setCover } from '@delb/epub';

const result = await setCover(epubBytes, {
  data: jpegBytes,
  mediaType: 'image/jpeg',
});
```

The main export works with `Uint8Array` values and does not use Node APIs. File
helpers are available from `@delb/epub/node` and always require an explicit
output path.

Version 0.1 supports EPUB 2 and EPUB 3 JPEG/PNG cover insertion, replacement,
repair, and inspection. Signed EPUBs and encrypted cover resources are rejected.

## API

- `inspectCover(epub, options?)` detects declared covers, guide wrappers, and
  simple image-only first-spine cover pages.
- `setCover(epub, cover, options?)` replaces or repairs a detected cover and
  inserts an SVG-backed title page when none exists.
- `replaceCover(epub, cover, options?)` requires a detectable existing cover.
- `inspectCoverFile`, `setCoverFile`, and `replaceCoverFile` from
  `@delb/epub/node` accept paths and atomically write a required output path.

Mutation results include the new EPUB bytes, the action performed, a fresh
cover inspection, and non-fatal preservation warnings. Inputs are never
mutated. `keepAspectRatio` defaults to `true`; image resizing and transcoding
remain the caller's responsibility.

Archive limits default to 10,000 entries, 1 GiB total uncompressed data, and
256 MiB per entry. They can be lowered or raised through the `limits` option.
All archive paths are validated before extraction. Output follows OCF ZIP
requirements by writing `mimetype` first, uncompressed, with exact
`application/epub+zip` contents and no ZIP extras.

This package deliberately focuses on EPUB structure. It does not attempt
Calibre-style rendering or conversion between unrelated ebook formats.

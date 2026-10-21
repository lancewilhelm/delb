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

`repairMimetype` defaults to `false`. Cover mutation callers can opt in to
normalizing a missing or empty `mimetype` entry, or the expected value with a
UTF-8 BOM or surrounding ASCII whitespace. Other declared MIME types and
malformed bytes are rejected. Repair requires an OCF container with the expected
namespace, version, and package declaration. It also requires package metadata,
unique manifest IDs, existing local manifest resources, and recognized XML
reading documents referenced by the spine. This conservative check is not a full
EPUB conformance validator. Packages with remote manifest resources are not
eligible for this repair.

Repair returns `mimetypeRepaired: true` and a warning. Inspection keeps its existing
validation behavior. Signature, cover-encryption, path, and archive-limit guards
still apply. Repair changes only the returned bytes, and file adapters retain
their explicit atomic output requirement. The Delb cover-upload endpoint opts in
to repair and commits the repaired EPUB together with the new cover files.

Archive limits default to 10,000 entries, 1 GiB total uncompressed data, and
256 MiB per entry. They can be lowered or raised through the `limits` option.
All archive paths are validated before extraction. For canonical marker input or
successful guarded repair, output follows OCF ZIP requirements by writing
`mimetype` first, uncompressed, with exact `application/epub+zip` contents and no
ZIP extras. The legacy reader accepts a UTF-8 BOM through text decoding; enable
`repairMimetype` to normalize that variant too.

This package deliberately focuses on EPUB structure. It does not attempt
Calibre-style rendering or conversion between unrelated ebook formats.

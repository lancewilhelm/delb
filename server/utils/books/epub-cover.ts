import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

import { EPub } from "epub2";
import sharp from "sharp";

/**
 * Best-effort extracted cover information.
 */
export type ExtractedCover = {
  /**
   * Relative path where the cover was written (POSIX-style, e.g. `data/books/A/T/cover.webp`)
   */
  relativePath: string;
  /**
   * MIME type we believe the original cover bytes represent.
   */
  mimeType: string;
  /**
   * File extension used for the stored image (e.g. `jpg`).
   */
  extension: string;
  /**
   * Size in bytes of the stored file.
   */
  byteLength: number;
};

/**
 * Try to extract a cover image from an EPUB buffer and store it on disk.
 *
 * Strategy (best-effort):
 * 1) Let `epub2` parse metadata/manifest.
 * 2) Prefer `epub.cover` if available (common in `epub2`).
 * 3) Fallback: scan manifest for an item with id including "cover" and image mime.
 * 4) Read cover bytes via `getImage(...)` or `getFile(...)`.
 * 5) Convert to a small WebP thumbnail asset using `sharp` (stable display + small size).
 *
 * Returns `null` if no cover could be extracted.
 */
export async function extractAndStoreEpubCover(opts: {
  /**
   * Absolute path to the EPUB file on disk (epub2 expects a file path).
   */
  epubFilePath: string;

  /**
   * Directory to store cover image into (absolute path).
   */
  outputDirAbsolute: string;

  /**
   * Relative path (POSIX) to store in the DB (e.g. `data/books/A/T/cover.webp`).
   * The function will write the cover image to the absolute equivalent of this.
   */
  outputRelativePathPosix: string;

  /**
   * Max thumbnail width in pixels (default 320).
   */
  maxWidth?: number;

  /**
   * WebP quality (default 80).
   */
  webpQuality?: number;
}): Promise<ExtractedCover | null> {
  const maxWidth = opts.maxWidth ?? 320;
  const webpQuality = opts.webpQuality ?? 80;

  const epub = new EPub(opts.epubFilePath);

  const parse = () =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => {
        cleanup();
        reject(err);
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };

      const onErrorListener = onError as unknown as (
        ...args: unknown[]
      ) => void;
      const onEndListener = onEnd as unknown as (...args: unknown[]) => void;

      const cleanup = () => {
        epub.removeListener("error", onErrorListener);
        epub.removeListener("end", onEndListener);
      };

      epub.on("error", onErrorListener);
      epub.on("end", onEndListener);
      epub.parse();
    });

  await parse();

  type EpubManifestItem = {
    id?: string;
    href?: string;
    mediaType?: string;
  };

  type EpubLike = {
    cover?: unknown;
    manifest?: Record<string, EpubManifestItem> | unknown;
    getImage?: (
      id: string,
      cb: (err: unknown, data: unknown, mime?: unknown) => void,
    ) => void;
    getFile?: (
      idOrHref: string,
      cb: (err: unknown, data: unknown, mime?: unknown) => void,
    ) => void;
  };

  const anyEpub = epub as unknown as EpubLike;

  // `cover` is sometimes a file id/href; sometimes object; sometimes undefined.
  const coverRef: unknown = anyEpub?.cover;

  const manifest: EpubManifestItem[] | undefined =
    anyEpub?.manifest &&
    typeof anyEpub.manifest === "object" &&
    !Array.isArray(anyEpub.manifest)
      ? (Object.values(anyEpub.manifest as Record<string, EpubManifestItem>) ??
        undefined)
      : undefined;

  const isImageMime = (mt?: string) =>
    typeof mt === "string" && mt.toLowerCase().startsWith("image/");

  const pickCoverCandidate = (): EpubManifestItem | null => {
    // 1) Try an explicit cover reference if it looks like an id/href
    if (typeof coverRef === "string" && coverRef.trim()) {
      // Might be an id in the manifest or an href.
      const byId =
        manifest?.find((m) => m?.id === coverRef) ??
        manifest?.find((m) => m?.href === coverRef) ??
        null;
      if (byId && isImageMime(byId.mediaType)) {
        return { id: byId.id, href: byId.href, mediaType: byId.mediaType };
      }

      // Fallback: treat as href if it looks like a path
      if (coverRef.includes("/") || coverRef.includes(".")) {
        return { href: coverRef, mediaType: undefined };
      }
    }

    // 2) Scan manifest for common cover patterns
    const candidates =
      manifest
        ?.filter((m) => isImageMime(m?.mediaType))
        ?.map((m) => ({
          id: m?.id,
          href: m?.href,
          mediaType: m?.mediaType,
          score: scoreCoverCandidate(m),
        }))
        ?.sort((a, b) => b.score - a.score) ?? [];

    const best = candidates[0];
    if (best && best.score > 0) {
      return { id: best.id, href: best.href, mediaType: best.mediaType };
    }

    return null;
  };

  const scoreCoverCandidate = (m: EpubManifestItem): number => {
    const id = (m?.id ?? "").toString().toLowerCase();
    const href = (m?.href ?? "").toString().toLowerCase();
    const mt = (m?.mediaType ?? "").toString().toLowerCase();

    let score = 0;

    if (id.includes("cover")) score += 5;
    if (href.includes("cover")) score += 5;

    // Common filename hints
    if (href.includes("front")) score += 2;
    if (href.includes("thumbnail")) score -= 2;

    // Prefer jpeg/png over svg/gif for covers
    if (mt.includes("jpeg") || mt.includes("jpg")) score += 2;
    if (mt.includes("png")) score += 1;
    if (mt.includes("svg")) score -= 3;
    if (mt.includes("gif")) score -= 2;

    return score;
  };

  const candidate = pickCoverCandidate();
  if (!candidate) return null;

  const readBytes = async (): Promise<{
    bytes: Buffer;
    mimeType: string;
  } | null> => {
    // Many `epub2` builds provide `getImage(id, cb)` and/or `getFile(idOrHref, cb)`.
    const getImage = anyEpub?.getImage?.bind(epub) as
      | ((
          id: string,
          cb: (err: unknown, data: unknown, mime?: unknown) => void,
        ) => void)
      | undefined;

    const getFile = anyEpub?.getFile?.bind(epub) as
      | ((
          idOrHref: string,
          cb: (err: unknown, data: unknown, mime?: unknown) => void,
        ) => void)
      | undefined;

    const wrapCb = (
      fn:
        | ((
            idOrHref: string,
            cb: (err: unknown, data: unknown, mime?: unknown) => void,
          ) => void)
        | ((
            id: string,
            cb: (err: unknown, data: unknown, mime?: unknown) => void,
          ) => void),
      idOrHref: string,
    ): Promise<[unknown, unknown]> =>
      new Promise<[unknown, unknown]>((resolve, reject) => {
        fn(idOrHref, (err, data, mime) => {
          if (err) return reject(err);
          resolve([data, mime]);
        });
      });

    // Try cover by id first (more reliable than href in `epub2`)
    if (candidate.id && typeof getImage === "function") {
      try {
        const [data, mime] = await wrapCb(getImage, candidate.id);
        if (Buffer.isBuffer(data)) {
          return {
            bytes: data,
            mimeType: (
              (typeof mime === "string" ? mime : undefined) ||
              candidate.mediaType ||
              "application/octet-stream"
            ).toString(),
          };
        }
      } catch {
        // ignore, fall through
      }
    }

    // Try getFile by id
    if (candidate.id && typeof getFile === "function") {
      try {
        const [data, mime] = await wrapCb(getFile, candidate.id);
        if (Buffer.isBuffer(data)) {
          return {
            bytes: data,
            mimeType: (
              (typeof mime === "string" ? mime : undefined) ||
              candidate.mediaType ||
              "application/octet-stream"
            ).toString(),
          };
        }
      } catch {
        // ignore, fall through
      }
    }

    // Try getFile by href
    if (candidate.href && typeof getFile === "function") {
      try {
        const [data, mime] = await wrapCb(getFile, candidate.href);
        if (Buffer.isBuffer(data)) {
          return {
            bytes: data,
            mimeType: (
              (typeof mime === "string" ? mime : undefined) ||
              candidate.mediaType ||
              "application/octet-stream"
            ).toString(),
          };
        }
      } catch {
        // ignore
      }
    }

    return null;
  };

  const cover = await readBytes();
  if (!cover) return null;

  // Ensure output directory exists
  await mkdir(opts.outputDirAbsolute, { recursive: true });

  // Normalize output path; caller supplies relative POSIX path for DB storage.
  // The absolute output file path is derived from outputDirAbsolute + basename.
  const outBasename = path.posix.basename(opts.outputRelativePathPosix);
  const outAbsolute = path.join(opts.outputDirAbsolute, outBasename);

  // Convert to small WebP for easy display and consistent thumbnails.
  // If conversion fails (e.g. unsupported image), fall back to raw bytes save.
  let outBytes: Buffer;
  let mimeType = "image/webp";
  let extension = "webp";

  try {
    outBytes = await sharp(cover.bytes)
      .rotate() // respect EXIF when present
      .resize({ width: maxWidth, withoutEnlargement: true })
      .webp({ quality: webpQuality })
      .toBuffer();
  } catch {
    // Fallback: store as-is with best guess extension; still write to requested path.
    outBytes = cover.bytes;
    mimeType = cover.mimeType || "application/octet-stream";

    // Attempt to infer an extension from mimeType; otherwise keep ".bin".
    if (mimeType.includes("webp")) extension = "webp";
    else if (mimeType.includes("png")) extension = "png";
    else if (mimeType.includes("jpeg") || mimeType.includes("jpg"))
      extension = "jpg";
    else extension = "bin";
  }

  await writeFile(outAbsolute, outBytes);

  return {
    relativePath: opts.outputRelativePathPosix,
    mimeType,
    extension,
    byteLength: outBytes.byteLength,
  };
}

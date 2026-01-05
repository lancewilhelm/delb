import path from "node:path";
import { mkdir, stat, writeFile } from "node:fs/promises";

import sharp from "sharp";

export type StoredCover = {
  /**
   * Relative POSIX path stored in DB, e.g. `library/A/Book (id8)/cover.source.jpg`
   */
  relativePath: string;
  /** Absolute path on disk where the file was written */
  absPath: string;
  /** MIME type for the written file */
  mimeType: string;
  /** File extension (no dot), e.g. `jpg`, `png`, `webp` */
  extension: string;
  /** Size in bytes of the written file */
  byteLength: number;
  /** Pixel dimensions if detectable */
  width?: number;
  height?: number;
};

export type CoverPair = {
  source: StoredCover;
  thumb: StoredCover;
};

export type EnsureCoverOutputsResult = {
  /** Written/ensured cover artifacts */
  covers: CoverPair;
  /** true if any file was written/overwritten */
  changed: boolean;
};

export type CoverProcessingOptions = {
  /**
   * Absolute directory where cover files should be written (book folder).
   * Example: `<projectRoot>/library/<author>/<title (id8)>`
   */
  outputDirAbs: string;

  /**
   * Relative POSIX directory (book folder), prefixed with `library/`.
   * Example: `library/<author>/<title (id8)>`
   */
  outputDirRelPosix: string;

  /**
   * Base filename for the source cover. Defaults to `cover.source`.
   * Extension will be inferred or set by `sourceFormat`.
   */
  sourceBaseName?: string;

  /**
   * Base filename for the thumbnail cover. Defaults to `cover.thumb.webp`.
   */
  thumbFileName?: string;

  /**
   * Thumbnail max width in pixels (default 320).
   */
  thumbMaxWidth?: number;

  /**
   * WebP quality (default 80) for generated thumbnail.
   */
  thumbWebpQuality?: number;

  /**
   * If true, do not overwrite existing files (default true).
   * - If the file exists, we keep it and return metadata based on on-disk file.
   * - If the file is missing, we create it.
   */
  doNotOverwrite?: boolean;

  /**
   * If provided, force the source file format regardless of input.
   * - "original": keep the original bytes as-is and use inferred extension/mime
   * - "jpg" | "png" | "webp": transcode to that format
   *
   * Default: "original"
   */
  sourceFormat?: "original" | "jpg" | "png" | "webp";

  /**
   * If transcoding source, quality (0-100). Used for jpg/webp.
   * Defaults: jpg 85, webp 90.
   */
  sourceQuality?: number;
};

function normalizePosix(p: string): string {
  return (p ?? "")
    .toString()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function ensureRelUnderLibraryDir(relPosix: string) {
  const norm = normalizePosix(relPosix);
  if (!norm.startsWith("library/")) {
    throw createError({
      statusCode: 500,
      statusMessage: `Expected a path under library/, got: ${relPosix}`,
    });
  }
}

function extFromMime(mime: string): string | null {
  const m = (mime ?? "").toLowerCase();
  if (m.includes("image/jpeg") || m.includes("image/jpg")) return "jpg";
  if (m.includes("image/png")) return "png";
  if (m.includes("image/webp")) return "webp";
  if (m.includes("image/gif")) return "gif";
  if (m.includes("image/svg")) return "svg";
  return null;
}

function mimeFromExt(ext: string): string {
  const e = (ext ?? "").toLowerCase();
  if (e === "jpg" || e === "jpeg") return "image/jpeg";
  if (e === "png") return "image/png";
  if (e === "webp") return "image/webp";
  if (e === "gif") return "image/gif";
  if (e === "svg") return "image/svg+xml";
  return "application/octet-stream";
}

async function fileExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function sniffImageInfo(bytes: Buffer): Promise<{
  mimeType: string;
  width?: number;
  height?: number;
}> {
  // sharp().metadata() is the most reliable way we have here
  try {
    const meta = await sharp(bytes).metadata();
    const mimeType =
      typeof meta.format === "string" && meta.format.toLowerCase() === "jpeg"
        ? "image/jpeg"
        : typeof meta.format === "string" && meta.format.toLowerCase() === "png"
          ? "image/png"
          : typeof meta.format === "string" &&
              meta.format.toLowerCase() === "webp"
            ? "image/webp"
            : typeof meta.format === "string" &&
                meta.format.toLowerCase() === "gif"
              ? "image/gif"
              : typeof meta.format === "string" &&
                  meta.format.toLowerCase() === "svg"
                ? "image/svg+xml"
                : "application/octet-stream";

    return {
      mimeType,
      width: typeof meta.width === "number" ? meta.width : undefined,
      height: typeof meta.height === "number" ? meta.height : undefined,
    };
  } catch {
    // Unknown/unsupported; fall back
    return { mimeType: "application/octet-stream" };
  }
}

async function buildStoredCoverFromDisk(opts: {
  absPath: string;
  relPosix: string;
}): Promise<StoredCover> {
  const ext = path.extname(opts.absPath).replace(/^\./, "").toLowerCase();
  const mimeType = mimeFromExt(ext);
  const st = await stat(opts.absPath);

  // Best-effort dimensions: try reading file (small cost, but acceptable here since this
  // path is used only at import/processing time).
  let width: number | undefined;
  let height: number | undefined;
  try {
    const buf = await import("node:fs/promises").then((m) =>
      m.readFile(opts.absPath),
    );
    const meta = await sharp(buf).metadata();
    width = typeof meta.width === "number" ? meta.width : undefined;
    height = typeof meta.height === "number" ? meta.height : undefined;
  } catch {
    // ignore
  }

  return {
    relativePath: opts.relPosix,
    absPath: opts.absPath,
    mimeType,
    extension: ext || "bin",
    byteLength: st.size,
    width,
    height,
  };
}

/**
 * Write (or ensure) a cover pair composed of:
 * - a "source" cover: original bytes (default) or transcoded, intended for full-res viewing
 * - a "thumb" cover: WebP 320px wide for use throughout the UI
 *
 * This helper centralizes cover policy so:
 * - EPUB uploads can keep true original (source) while using a thumb in UI
 * - Calibre import can point to an existing on-disk source cover (cover.jpg/png) and generate a thumb
 *
 * Security note:
 * - This function assumes the caller already resolved and validated that `outputDirAbs`
 *   is within the server-owned `library/` folder. It does enforce that the *relative*
 *   paths are under `library/` to avoid accidental DB corruption.
 */
export async function ensureCoverOutputsFromBytes(opts: {
  sourceBytes: Buffer;

  /**
   * If known, you may pass the mime type of the provided bytes (e.g. from upload headers).
   * If omitted, we'll sniff via sharp metadata.
   */
  sourceMimeTypeHint?: string | null;

  /**
   * If known, you may pass the original filename extension (no dot).
   * Used only when `sourceFormat: "original"` and mime sniffing fails.
   */
  sourceExtensionHint?: string | null;

  processing: CoverProcessingOptions;
}): Promise<EnsureCoverOutputsResult> {
  const p = opts.processing;

  const outputDirAbs = p.outputDirAbs;
  const outputDirRelPosix = normalizePosix(p.outputDirRelPosix);

  ensureRelUnderLibraryDir(outputDirRelPosix);

  const doNotOverwrite = p.doNotOverwrite ?? true;

  const thumbMaxWidth = p.thumbMaxWidth ?? 320;
  const thumbWebpQuality = p.thumbWebpQuality ?? 80;

  const sourceBaseName = (p.sourceBaseName ?? "cover.source").trim();
  const thumbFileName = (p.thumbFileName ?? "cover.thumb.webp").trim();

  const sourceFormat = p.sourceFormat ?? "original";

  // Determine "original" characteristics
  const sniffed = await sniffImageInfo(opts.sourceBytes);
  const inputMime =
    (opts.sourceMimeTypeHint ?? "").toString().trim() || sniffed.mimeType;
  const inputExt =
    extFromMime(inputMime) ||
    (opts.sourceExtensionHint ?? "").toString().trim().toLowerCase() ||
    "bin";

  // Decide source output ext/mime and bytes
  let sourceOutExt: string;
  let sourceOutMime: string;
  let sourceOutBytes: Buffer;

  if (sourceFormat === "original") {
    sourceOutExt = inputExt === "jpeg" ? "jpg" : inputExt;
    sourceOutMime = mimeFromExt(sourceOutExt);
    // "true original": store bytes as provided
    sourceOutBytes = opts.sourceBytes;
  } else if (sourceFormat === "jpg") {
    sourceOutExt = "jpg";
    sourceOutMime = "image/jpeg";
    const q = typeof p.sourceQuality === "number" ? p.sourceQuality : 85;
    sourceOutBytes = await sharp(opts.sourceBytes)
      .rotate()
      .jpeg({ quality: q })
      .toBuffer();
  } else if (sourceFormat === "png") {
    sourceOutExt = "png";
    sourceOutMime = "image/png";
    // PNG doesn't use "quality" in the same way; keep defaults
    sourceOutBytes = await sharp(opts.sourceBytes).rotate().png().toBuffer();
  } else {
    // webp
    sourceOutExt = "webp";
    sourceOutMime = "image/webp";
    const q = typeof p.sourceQuality === "number" ? p.sourceQuality : 90;
    sourceOutBytes = await sharp(opts.sourceBytes)
      .rotate()
      .webp({ quality: q })
      .toBuffer();
  }

  const sourceFileName = `${sourceBaseName}.${sourceOutExt}`;
  const sourceAbs = path.join(outputDirAbs, sourceFileName);
  const sourceRelPosix = [outputDirRelPosix, sourceFileName].join("/");

  const thumbAbs = path.join(outputDirAbs, thumbFileName);
  const thumbRelPosix = [outputDirRelPosix, thumbFileName].join("/");

  await mkdir(outputDirAbs, { recursive: true });

  let changed = false;

  // Source write (if needed)
  if (!doNotOverwrite || !(await fileExists(sourceAbs))) {
    await writeFile(sourceAbs, sourceOutBytes);
    changed = true;
  }

  // Thumb write (if needed)
  if (!doNotOverwrite || !(await fileExists(thumbAbs))) {
    const thumbBytes = await sharp(sourceOutBytes)
      .rotate()
      .resize({ width: thumbMaxWidth, withoutEnlargement: true })
      .webp({ quality: thumbWebpQuality })
      .toBuffer();

    await writeFile(thumbAbs, thumbBytes);
    changed = true;
  }

  const sourceStored = await buildStoredCoverFromDisk({
    absPath: sourceAbs,
    relPosix: sourceRelPosix,
  });

  // Override stored mime/ext for source when we know better (e.g. original unknown bin)
  sourceStored.mimeType =
    sourceFormat === "original" ? inputMime : sourceOutMime;
  sourceStored.extension = sourceOutExt;

  const thumbStored = await buildStoredCoverFromDisk({
    absPath: thumbAbs,
    relPosix: thumbRelPosix,
  });

  // Ensure thumb is described as webp even if metadata probing fails
  thumbStored.mimeType = "image/webp";
  thumbStored.extension = "webp";

  return {
    covers: { source: sourceStored, thumb: thumbStored },
    changed,
  };
}

/**
 * Convenience wrapper when you already have a source image on disk (e.g. Calibre import cover.jpg/png).
 * Reads the bytes and then generates the thumb next to it, while optionally also copying/transcoding
 * to your canonical `cover.source.<ext>` name.
 */
export async function ensureCoverOutputsFromExistingFile(opts: {
  /**
   * Absolute path to the existing source cover file on disk.
   * Example: `<projectRoot>/library/<calibreRelDir>/cover.jpg`
   */
  existingSourceAbs: string;

  /**
   * Relative POSIX path (prefixed with `library/`) to the existing source cover.
   * This is NOT necessarily the same as the canonical `cover.source.*` you write;
   * it's used for mime/extension hints and sanity checking.
   */
  existingSourceRelPosix: string;

  processing: CoverProcessingOptions;
}): Promise<EnsureCoverOutputsResult> {
  ensureRelUnderLibraryDir(opts.existingSourceRelPosix);

  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(opts.existingSourceAbs);

  const ext = path
    .extname(opts.existingSourceAbs)
    .replace(/^\./, "")
    .toLowerCase();

  const mime = mimeFromExt(ext);

  return ensureCoverOutputsFromBytes({
    sourceBytes: bytes,
    sourceMimeTypeHint: mime,
    sourceExtensionHint: ext,
    processing: opts.processing,
  });
}

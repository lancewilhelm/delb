import { EPub } from "epub2";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type EpubMetadata = {
  title: string;
  author: string;
  language?: string;
  identifier?: string;
  publisher?: string;
  published?: string;
};

function firstNonEmpty(...values: Array<unknown>): string | undefined {
  for (const v of values) {
    if (typeof v === "string") {
      const s = v.trim();
      if (s) return s;
    }
  }
  return undefined;
}

/**
 * Parse basic metadata (title/author/etc) from an EPUB buffer.
 *
 * Notes:
 * - `epub2` expects a file path (string) in its constructor, so we write the buffer
 *   to a temporary file and parse from there.
 * - For MVP we only *require* `title` and `author` (fallbacks applied).
 */
export async function parseEpubMetadataFromBuffer(
  buffer: Buffer,
  opts?: { fallbackTitle?: string },
): Promise<EpubMetadata> {
  const fallbackTitle = opts?.fallbackTitle?.trim() || "Untitled";

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "delb-epub-"));
  const tmpFilePath = path.join(tmpDir, "upload.epub");
  await writeFile(tmpFilePath, buffer);

  const epub = new EPub(tmpFilePath);

  try {
    return await new Promise<EpubMetadata>((resolve, reject) => {
      const onError = (err: unknown) => {
        cleanup();
        reject(err);
      };

      const onEnd = () => {
        try {
          const metadataUnknown: unknown = (
            epub as unknown as { metadata?: unknown }
          ).metadata;

          const m =
            metadataUnknown && typeof metadataUnknown === "object"
              ? (metadataUnknown as Record<string, unknown>)
              : {};

          const title = firstNonEmpty(m.title, m["dc:title"]) ?? fallbackTitle;

          // `epub2` often provides `creator` or `creatorFileAs`.
          // Sometimes it's `author`. We normalize to a single string.
          const author =
            firstNonEmpty(
              m.creator,
              m.creatorFileAs,
              m.author,
              m["dc:creator"],
            ) ?? "Unknown Author";

          const language = firstNonEmpty(m.language, m["dc:language"]);
          const identifier = firstNonEmpty(m.identifier, m["dc:identifier"]);
          const publisher = firstNonEmpty(m.publisher, m["dc:publisher"]);
          const published = firstNonEmpty(m.date, m["dc:date"]);

          cleanup();
          resolve({
            title,
            author,
            language,
            identifier,
            publisher,
            published,
          });
        } catch (e) {
          cleanup();
          reject(e);
        }
      };

      const cleanup = () => {
        epub.removeListener(
          "error",
          onError as unknown as (...args: unknown[]) => void,
        );
        epub.removeListener(
          "end",
          onEnd as unknown as (...args: unknown[]) => void,
        );
      };

      epub.on("error", onError as unknown as (...args: unknown[]) => void);
      epub.on("end", onEnd as unknown as (...args: unknown[]) => void);

      // Triggers parsing
      epub.parse();
    });
  } finally {
    // Best-effort cleanup of temp dir + file
    await rm(tmpDir, { recursive: true, force: true });
  }
}

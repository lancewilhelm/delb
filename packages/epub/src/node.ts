import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectCover, replaceCover, setCover } from './cover.js';
import type {
  CoverInspection,
  CoverMediaType,
  CoverMutationOptions,
  CoverMutationResult,
  EpubReadOptions,
} from './types.js';

export interface CoverFileOptions extends CoverMutationOptions {
  outputPath: string;
  mediaType?: CoverMediaType;
}

export async function inspectCoverFile(
  epubPath: string,
  options?: EpubReadOptions,
): Promise<CoverInspection | undefined> {
  return inspectCover(await readFile(epubPath), options);
}

export async function setCoverFile(
  epubPath: string,
  coverPath: string,
  options: CoverFileOptions,
): Promise<Omit<CoverMutationResult, 'data'>> {
  return mutateFile(epubPath, coverPath, options, false);
}

export async function replaceCoverFile(
  epubPath: string,
  coverPath: string,
  options: CoverFileOptions,
): Promise<Omit<CoverMutationResult, 'data'>> {
  return mutateFile(epubPath, coverPath, options, true);
}

async function mutateFile(
  epubPath: string,
  coverPath: string,
  options: CoverFileOptions,
  requireExisting: boolean,
): Promise<Omit<CoverMutationResult, 'data'>> {
  if (!options?.outputPath) throw new TypeError('outputPath is required');
  const mediaType = options.mediaType ?? mediaTypeFromPath(coverPath);
  const [epub, cover] = await Promise.all([
    readFile(epubPath),
    readFile(coverPath),
  ]);
  const result = requireExisting
    ? await replaceCover(epub, { data: cover, mediaType }, options)
    : await setCover(epub, { data: cover, mediaType }, options);
  await atomicWrite(options.outputPath, result.data);
  const { data: _data, ...withoutData } = result;
  return withoutData;
}

async function atomicWrite(
  outputPath: string,
  data: Uint8Array,
): Promise<void> {
  const directory = path.dirname(path.resolve(outputPath));
  const tempDirectory = await mkdtemp(
    path.join(directory, `.${path.basename(outputPath)}.tmp-`),
  );
  const tempPath = path.join(tempDirectory, path.basename(outputPath));
  const backupPath = path.join(
    tempDirectory,
    `${path.basename(outputPath)}.backup`,
  );
  let backedUp = false;
  let removeTempDirectory = true;
  try {
    await writeFile(tempPath, data, { flag: 'wx' });
    try {
      await rename(outputPath, backupPath);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(tempPath, outputPath);
  } catch (error) {
    if (backedUp) {
      try {
        await rename(backupPath, outputPath);
      } catch (rollbackError) {
        removeTempDirectory = false;
        throw new AggregateError(
          [error, rollbackError],
          `Writing ${outputPath} failed and its backup remains at ${backupPath}`,
        );
      }
    }
    throw error;
  } finally {
    if (removeTempDirectory)
      await rm(tempDirectory, { recursive: true, force: true });
  }
}

function mediaTypeFromPath(filePath: string): CoverMediaType {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  throw new TypeError(
    'Cover image must be a JPEG or PNG, or mediaType must be provided',
  );
}

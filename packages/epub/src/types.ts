export type CoverMediaType = 'image/jpeg' | 'image/png';

export interface CoverImageInput {
  data: Uint8Array;
  mediaType: CoverMediaType;
}

export interface ArchiveLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

export interface EpubReadOptions {
  limits?: Partial<ArchiveLimits>;
}

export interface CoverMutationOptions extends EpubReadOptions {
  keepAspectRatio?: boolean;
}

export interface CoverInspection {
  epubVersion: 2 | 3;
  imagePath: string;
  imageId: string;
  mediaType: string;
  titlePagePath?: string;
  source: 'epub3-property' | 'epub2-meta' | 'guide' | 'first-spine';
  imageData: Uint8Array;
}

export interface CoverMutationResult {
  data: Uint8Array;
  action: 'inserted' | 'replaced' | 'repaired';
  cover: CoverInspection;
  warnings: string[];
}

export type EpubErrorCode =
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ENCRYPTED_COVER'
  | 'INVALID_EPUB'
  | 'MISSING_COVER'
  | 'SIGNED_EPUB'
  | 'UNSUPPORTED_IMAGE';

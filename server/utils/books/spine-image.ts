import sharp from 'sharp';
import type { SpineEdits } from '~~/shared/spine-artwork';

export const SPINE_MAX_BYTES = 10 * 1024 * 1024;
export async function renderSpine(
  bytes: Buffer,
  edits: SpineEdits,
): Promise<{ image: Buffer; contentType: string }> {
  if (!bytes.length || bytes.length > SPINE_MAX_BYTES)
    throw new Error('Invalid image size');
  const input = sharp(bytes, { limitInputPixels: 24_000_000, animated: false });
  const metadata = await input.metadata();
  const contentType =
    metadata.format === 'jpeg'
      ? 'image/jpeg'
      : metadata.format === 'png'
        ? 'image/png'
        : metadata.format === 'webp'
          ? 'image/webp'
          : metadata.format === 'heif' && metadata.compression === 'av1'
            ? 'image/avif'
            : null;
  if (!contentType || (metadata.pages ?? 1) > 1)
    throw new Error('Unsupported image');
  const width = metadata.autoOrient?.width ?? metadata.width,
    height = metadata.autoOrient?.height ?? metadata.height;
  if (!width || !height) throw new Error('Missing image dimensions');
  const left = Math.floor((width * edits.left) / 100),
    top = Math.floor((height * edits.top) / 100);
  const right = Math.floor((width * edits.right) / 100),
    bottom = Math.floor((height * edits.bottom) / 100);
  const crop = {
    left,
    top,
    width: width - left - right,
    height: height - top - bottom,
  };
  let image = input.rotate().extract(crop);
  if (edits.stretch)
    image = image.resize({ width: 256, height: 768, fit: 'fill' });
  else
    image = image.resize({
      width: 512,
      height: 1600,
      fit: 'inside',
      withoutEnlargement: true,
    });
  return { image: await image.webp({ quality: 90 }).toBuffer(), contentType };
}

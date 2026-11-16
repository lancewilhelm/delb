import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import {
  defaultSpineEdits,
  parseSpineEdits,
} from '../../../shared/spine-artwork';
import { renderSpine } from './spine-image';

test('spine rendition crops the chosen edges and stretches only when requested', async () => {
  const source = await sharp({
    create: { width: 100, height: 300, channels: 3, background: '#ff0000' },
  })
    .composite([
      {
        input: await sharp({
          create: {
            width: 100,
            height: 150,
            channels: 3,
            background: '#00ff00',
          },
        })
          .png()
          .toBuffer(),
        top: 150,
        left: 0,
      },
    ])
    .png()
    .toBuffer();
  const cropped = await renderSpine(source, {
    ...defaultSpineEdits(),
    top: 50,
  });
  const decoded = await sharp(cropped.image)
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(cropped.contentType, 'image/png');
  assert.equal(decoded.info.width, 100);
  assert.equal(decoded.info.height, 150);
  assert.ok(decoded.data[1]! > 200 && decoded.data[0]! < 50);
  const fineEdits = parseSpineEdits({ ...defaultSpineEdits(), top: 50.5 });
  assert.ok(fineEdits);
  const fineCrop = await renderSpine(source, fineEdits);
  assert.equal((await sharp(fineCrop.image).metadata()).height, 149);
  const stretched = await renderSpine(source, {
    ...defaultSpineEdits(),
    top: 50,
    stretch: true,
  });
  const metadata = await sharp(stretched.image).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 768);
});

test('spine crops use the orientation shown to the reader', async () => {
  const source = await sharp({
    create: { width: 40, height: 120, channels: 3, background: '#fff' },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const result = await renderSpine(source, {
    ...defaultSpineEdits(),
    left: 50,
  });
  const metadata = await sharp(result.image).metadata();
  assert.equal(metadata.width, 60);
  assert.equal(metadata.height, 40);
});

test('rejects invalid crop settings and unsupported or oversized images', async () => {
  assert.equal(
    parseSpineEdits({ ...defaultSpineEdits(), left: 50, right: 50 }),
    null,
  );
  assert.equal(
    parseSpineEdits({ ...defaultSpineEdits(), stretch: 'yes' }),
    null,
  );
  assert.equal(
    parseSpineEdits({ ...defaultSpineEdits(), left: Infinity }),
    null,
  );
  await assert.rejects(
    renderSpine(
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      defaultSpineEdits(),
    ),
  );
  await assert.rejects(
    renderSpine(Buffer.alloc(10 * 1024 * 1024 + 1), defaultSpineEdits()),
  );
});

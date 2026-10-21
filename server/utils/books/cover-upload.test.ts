import assert from 'node:assert/strict';
import path from 'node:path';
import {
  mkdir,
  readFile,
  writeFile,
  mkdtemp,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import sharp from 'sharp';
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { and, eq, inArray } from 'drizzle-orm';
import * as schema from '../../../app/utils/db/schema.ts';
import {
  EpubError,
  inspectCover,
  setCover,
} from '../../../packages/epub/dist/index.js';
import {
  readArchive,
  writeArchive,
} from '../../../packages/epub/dist/archive.js';
import * as transaction from './cover-update-transaction.ts';

type TestEvent = { id: string; headers: Headers; image: Buffer };
type UploadResponse = { data: { embeddedEpubs: number; warnings: string[] } };
type HttpFailure = {
  statusCode: number;
  statusMessage: string;
  data?: { code?: string; relativePath?: string };
};
type UploadResult = {
  status: number;
  response?: UploadResponse;
  message?: string;
  code?: string;
  data?: HttpFailure['data'];
};

test('cover uploads preserve files and database on every rejected EPUB or image', async (t) => {
  const repo = process.cwd();
  const root = await mkdtemp(path.join(tmpdir(), 'delb-cover-upload-'));
  t.after(async () => {
    process.chdir(repo);
    client.close();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });

  const client = createClient({ url: `file:${root}/test.db` });
  const cloudDb = drizzle(client);
  await migrate(cloudDb, {
    migrationsFolder: path.join(repo, '.drizzle/migrations'),
  });
  const raw = await readFile('server/api/books/[id]/cover.post.ts', 'utf8');
  const ast = ts.createSourceFile(
    'cover.ts',
    raw,
    ts.ScriptTarget.Latest,
    true,
  );
  const source = ast.statements
    .filter((s) => !ts.isImportDeclaration(s))
    .map((s) => s.getText(ast))
    .join('\n');
  const js = ts
    .transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    })
    .outputText.replace('export default', 'return');
  const logs: { level: string; args: unknown[] }[] = [];
  const dependencies = {
    path,
    mkdir,
    readFile,
    readdir: (await import('node:fs/promises')).readdir,
    unlink: (await import('node:fs/promises')).unlink,
    EpubError,
    inspectCover,
    setCover,
    and,
    eq,
    inArray,
    sharp,
    cloudDb,
    ...transaction,
    ...schema,
    resolveDataPath: (p: string) => path.resolve(p),
    getCanonicalBookPaths: () => {
      throw Error('unexpected canonical path');
    },
    logger: Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((k) => [
        k,
        (...args: unknown[]) =>
          logs.push({
            level: k,
            args: args.map((a) =>
              a instanceof Error ? { message: a.message, stack: a.stack } : a,
            ),
          }),
      ]),
    ),
    auth: {
      api: {
        getSession: async () => ({ user: { id: 'test-user', role: 'owner' } }),
      },
    },
    defineEventHandler: (f: unknown) => f,
    getRouterParam: (event: TestEvent) => event.id,
    readMultipartFormData: async (event: TestEvent) => [
      {
        name: 'file',
        filename: 'cover.png',
        type: 'image/png',
        data: event.image,
      },
    ],
    createError: (o: HttpFailure) =>
      Object.assign(new Error(o.statusMessage), o),
  };
  const handler = new Function(...Object.keys(dependencies), js)(
    ...Object.values(dependencies),
  ) as (event: TestEvent) => Promise<UploadResponse>;
  const enc = (s: string) => new TextEncoder().encode(s);
  const image = await sharp({
    create: { width: 2, height: 3, channels: 3, background: '#d57939' },
  })
    .png()
    .toBuffer();
  await writeFile(path.join(root, 'cover.png'), image);
  function fixture(kind: string, version = 3) {
    const files = new Map<string, Uint8Array>([
      ['mimetype', enc('application/epub+zip')],
      [
        'META-INF/container.xml',
        enc(
          '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
        ),
      ],
      [
        'book.opf',
        enc(
          `<package xmlns="http://www.idpf.org/2007/opf" version="${version}.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:test</dc:identifier><dc:title>Synthetic</dc:title><dc:language>en</dc:language>${version === 2 ? '<meta name="cover" content="cover"/>' : ''}</metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="cover" href="old.png" media-type="image/png" ${version === 3 ? 'properties="cover-image"' : ''}/></manifest><spine><itemref idref="chapter"/></spine></package>`,
        ),
      ],
      [
        'chapter.xhtml',
        enc(
          '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Test</title></head><body><p>Original synthetic text.</p></body></html>',
        ),
      ],
      ['old.png', image],
    ]);
    if (kind === 'signed')
      files.set(
        'META-INF/signatures.xml',
        enc(
          '<signatures xmlns="urn:oasis:names:tc:opendocument:xmlns:container"/>',
        ),
      );
    if (kind === 'encrypted-cover')
      files.set(
        'META-INF/encryption.xml',
        enc(
          '<encryption><EncryptedData><CipherData><CipherReference URI="old.png"/></CipherData></EncryptedData></encryption>',
        ),
      );
    if (kind === 'font-obfuscation')
      files.set(
        'META-INF/encryption.xml',
        enc(
          '<encryption><EncryptedData><CipherData><CipherReference URI="font.otf"/></CipherData></EncryptedData></encryption>',
        ),
      );
    if (kind === 'bad-percent')
      files.set(
        'book.opf',
        enc(
          new TextDecoder()
            .decode(files.get('book.opf'))
            .replace(
              '</manifest>',
              '<item id="extra" href="100%.css" media-type="text/css"/></manifest>',
            ),
        ),
      );
    if (kind === 'missing-cover') files.delete('old.png');
    return writeArchive(files);
  }
  const { zipSync, unzipSync } =
    await import('../../../packages/epub/node_modules/fflate/esm/index.mjs');

  process.chdir(root);
  await client.execute('DELETE FROM collection_members');
  await client.execute('DELETE FROM collection_books');
  await client.execute('DELETE FROM book_files');
  await client.execute('DELETE FROM books');
  await cloudDb
    .insert(schema.users)
    .values({
      id: 'test-user',
      name: 'Synthetic User',
      email: 'synthetic@example.invalid',
      emailVerified: false,
      role: 'owner',
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await cloudDb
    .insert(schema.collections)
    .values({ id: 'test-collection', name: 'Test', ownerUserId: 'test-user' })
    .onConflictDoNothing();
  await cloudDb.insert(schema.collectionMembers).values({
    collectionId: 'test-collection',
    userId: 'test-user',
    role: 'owner',
  });
  const cases = [
    'valid-epub3',
    'valid-epub2',
    'missing-cover',
    'font-obfuscation',
    'signed',
    'encrypted-cover',
    'bad-percent',
    'missing-mimetype',
    'empty-mimetype',
    'padded-mimetype',
    'newline-mimetype',
    'bom-mimetype',
    'wrong-mimetype',
    'repair-no-container',
    'repair-signed',
    'repair-encrypted',
    'multi-repair-one-bad',
    'multi-repair-one-missing',
    'invalid-image',
    'oversized-image',
    'multi-one-bad',
    'missing-file',
    'multi-one-missing',
  ];
  for (const kind of cases) {
    await t.test(kind, async () => {
      const id = kind;
      const dir = `library/${id}`;
      await mkdir(dir, { recursive: true });
      let epub = fixture(
        kind === 'repair-signed'
          ? 'signed'
          : kind === 'repair-encrypted'
            ? 'encrypted-cover'
            : kind,
        kind === 'valid-epub2' ? 2 : 3,
      );
      const repairs = [
        'missing-mimetype',
        'empty-mimetype',
        'padded-mimetype',
        'newline-mimetype',
        'bom-mimetype',
        'repair-no-container',
        'repair-signed',
        'repair-encrypted',
        'multi-repair-one-bad',
        'multi-repair-one-missing',
      ];
      if (repairs.includes(kind) || kind === 'wrong-mimetype') {
        const entries = unzipSync(epub);
        if (kind === 'newline-mimetype')
          entries.mimetype = enc('application/epub+zip\n');
        else if (kind === 'empty-mimetype') entries.mimetype = enc('');
        else if (kind === 'padded-mimetype')
          entries.mimetype = enc(' application/epub+zip\r\n');
        else if (kind === 'bom-mimetype')
          entries.mimetype = enc('\uFEFFapplication/epub+zip');
        else if (kind === 'wrong-mimetype')
          entries.mimetype = enc('application/zip');
        else delete entries.mimetype;
        if (kind === 'repair-no-container')
          delete entries['META-INF/container.xml'];
        epub = zipSync(entries);
      }
      await writeFile(`${dir}/original.epub`, epub);
      await writeFile(`${dir}/cover.jpg`, 'old source');
      await writeFile(`${dir}/source.png`, 'old alternate source');
      await writeFile(`${dir}/thumb.webp`, 'old thumbnail');
      await cloudDb.insert(schema.books).values({
        id,
        title: 'Synthetic',
        createdByUserId: 'test-user',
        coverImagePath: `${dir}/thumb.webp`,
      });
      await cloudDb
        .insert(schema.collectionBooks)
        .values({ collectionId: 'test-collection', bookId: id });
      await cloudDb.insert(schema.bookFiles).values({
        id: `${id}-file`,
        bookId: id,
        format: 'epub',
        relativePath: `${dir}/${kind === 'missing-file' ? 'absent' : 'original'}.epub`,
      });
      if (kind.startsWith('multi-')) {
        await writeFile(`${dir}/second.epub`, fixture('signed'));
        await cloudDb.insert(schema.bookFiles).values({
          id: `${id}-file2`,
          bookId: id,
          format: 'epub',
          relativePath: `${dir}/${kind.endsWith('missing') ? 'absent' : 'second'}.epub`,
        });
      }
      const originalHash = createHash('sha256').update(epub).digest('hex');
      const beforeBook = (
        await cloudDb.select().from(schema.books).where(eq(schema.books.id, id))
      )[0];
      const beforeFiles = Object.fromEntries(
        await Promise.all(
          (await readdir(dir))
            .sort()
            .map(async (name) => [name, await readFile(`${dir}/${name}`)]),
        ),
      );
      logs.length = 0;
      let result: UploadResult;
      try {
        result = {
          status: 200,
          response: await handler({
            id,
            headers: new Headers(),
            image:
              kind === 'invalid-image'
                ? Buffer.from('not an image')
                : kind === 'oversized-image'
                  ? Buffer.alloc(25 * 1024 * 1024 + 1)
                  : image,
          }),
        };
      } catch (error) {
        const e = error as HttpFailure;
        result = {
          status: e.statusCode,
          message: e.statusMessage,
          code: e.data?.code,
          data: e.data,
        };
      }
      const after = await readFile(`${dir}/original.epub`);
      const unchanged =
        originalHash === createHash('sha256').update(after).digest('hex');
      const thumbUnchanged =
        (await readFile(`${dir}/thumb.webp`, 'utf8')) === 'old thumbnail';
      const db = (
        await cloudDb.select().from(schema.books).where(eq(schema.books.id, id))
      )[0];
      const rejected: Record<string, number> = {
        signed: 422,
        'encrypted-cover': 422,
        'bad-percent': 422,
        'wrong-mimetype': 422,
        'repair-no-container': 422,
        'repair-signed': 422,
        'repair-encrypted': 422,
        'invalid-image': 415,
        'oversized-image': 413,
        'multi-one-bad': 422,
        'multi-repair-one-bad': 422,
        'missing-file': 409,
        'multi-one-missing': 409,
        'multi-repair-one-missing': 409,
      };
      const expected = rejected[kind] ?? 200;
      assert.equal(result.status, expected, kind);
      const expectedCode: Record<string, string> = {
        signed: 'SIGNED_EPUB',
        'encrypted-cover': 'ENCRYPTED_COVER',
        'bad-percent': 'INVALID_EPUB',
        'wrong-mimetype': 'INVALID_EPUB',
        'repair-no-container': 'INVALID_EPUB',
        'repair-signed': 'SIGNED_EPUB',
        'repair-encrypted': 'ENCRYPTED_COVER',
        'multi-repair-one-bad': 'SIGNED_EPUB',
        'multi-repair-one-missing': 'EPUB_FILE_MISSING',
        'multi-one-bad': 'SIGNED_EPUB',
        'missing-file': 'EPUB_FILE_MISSING',
        'multi-one-missing': 'EPUB_FILE_MISSING',
      };
      if (expectedCode[kind]) assert.equal(result.code, expectedCode[kind]);
      if (expected !== 200) {
        assert.equal(unchanged, true, kind);
        assert.equal(thumbUnchanged, true, kind);
        assert.deepEqual(db, beforeBook);
        const afterFiles = Object.fromEntries(
          await Promise.all(
            (await readdir(dir))
              .sort()
              .map(async (name) => [name, await readFile(`${dir}/${name}`)]),
          ),
        );
        assert.deepEqual(afterFiles, beforeFiles);
        assert.equal(
          logs.some((log) => log.level === 'info'),
          false,
        );
        if (expectedCode[kind]) {
          const rejection = logs.find(
            (log) =>
              log.level === 'warn' &&
              (log.args[0] as Record<string, unknown>)?.code ===
                expectedCode[kind],
          );
          assert.ok(rejection, 'structured failure log includes error code');
          const context = rejection.args[0] as Record<string, unknown>;
          assert.equal(context.id, id);
          assert.equal(
            context.epubFileId,
            `${id}-${kind.startsWith('multi-') ? 'file2' : 'file'}`,
          );
          assert.equal(
            JSON.stringify(context).includes('Original synthetic text.'),
            false,
          );
        }

        if (expected === 409) {
          assert.equal(result.code, 'EPUB_FILE_MISSING');
          assert.equal(result.data?.relativePath, `${dir}/absent.epub`);
          assert.match(result.message ?? '', /Restore the file/);
          assert.equal(result.message?.includes(root), false);
        }
      } else {
        assert.equal((await inspectCover(after))?.mediaType, 'image/jpeg');
        const outputArchive = readArchive(after);
        assert.deepEqual(
          outputArchive.get('mimetype'),
          enc('application/epub+zip'),
        );
        assert.deepEqual(
          outputArchive.get('chapter.xhtml'),
          readArchive(epub).get('chapter.xhtml'),
        );
        if (repairs.includes(kind)) {
          assert.ok(
            result.response?.data.warnings.some((w) =>
              w.includes('Normalized'),
            ),
          );
          const normalized = logs.find((log) => log.level === 'info');
          assert.ok(normalized);
          const context = normalized.args[0] as Record<string, unknown>;
          assert.equal(context.code, 'EPUB_MIMETYPE_NORMALIZED');
          assert.deepEqual(context.epubFileIds, [`${id}-file`]);
        }

        assert.equal(result.response?.data.embeddedEpubs, 1);
        assert.deepEqual(await readFile(`${dir}/cover.png`), image);
        assert.equal(
          (await sharp(await readFile(`${dir}/thumb.webp`)).metadata()).format,
          'webp',
        );
      }
    });
  }
});

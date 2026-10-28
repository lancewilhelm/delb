import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const root =
  process.env.DELB_AUDIT_REPO ||
  path.resolve(import.meta.dirname, '../../../..');
const tmp = await fs.mkdtemp(
  path.join((await import('node:os')).tmpdir(), 'delb-storage-proof-'),
);
const require = createRequire(root + '/package.json');
const esbuild = require('esbuild');

async function load(rel, name, stub) {
  let source = await fs.readFile(root + '/' + rel, 'utf8');
  source = source.replace(
    /^import\s+(?:type\s+)?[\s\S]*?from\s+['"]([^'"]+)['"];\s*/gm,
    (all, mod) => (mod.startsWith('node:') ? all : ''),
  );
  if (name === 'move')
    source = source.replace(
      'await rename(src, dest);',
      `if (globalThis.failSidecar && src.endsWith('/side.txt')) throw new Error('injected rename failure'); await rename(src, dest);`,
    );
  let js = (
    await esbuild.transform(stub + '\n' + source, {
      loader: 'ts',
      format: 'esm',
      target: 'node20',
    })
  ).code;
  const p = tmp + '/' + name + '.mjs';
  await fs.writeFile(p, js);
  return import(pathToFileURL(p).href);
}
const cover = await import(
  pathToFileURL(root + '/server/utils/books/cover-update-transaction.ts').href
).catch(() => null);
const c =
  cover ??
  (await load('server/utils/books/cover-update-transaction.ts', 'cover', ''));
let dir = tmp + '/cover-fixture';
await fs.mkdir(dir, { recursive: true });
const file = dir + '/thumb.webp';
await fs.writeFile(file, 'OLD');
let release, entered;
const enteredP = new Promise((r) => (entered = r));
const barrier = new Promise((r) => (release = r));
const pending = c.commitCoverUpdate({
  operationParent: dir,
  allowedRoot: dir,
  previousCoverImagePath: 'library/thumb.webp',
  expectedCoverImagePath: 'library/thumb.webp',
  files: [{ targetPath: file, data: Buffer.from('NEW') }],
  commitDatabase: async () => {
    entered();
    await barrier;
  },
  rollbackDatabase: async () => {},
});
await enteredP;
await c.recoverPendingCoverUpdates({
  operationParent: dir,
  allowedRoot: dir,
  currentCoverImagePath: 'library/thumb.webp',
});
release();
let coverError;
try {
  await pending;
} catch (e) {
  coverError = e.code || e.message;
}
console.log(
  'COVER',
  JSON.stringify({
    error: coverError,
    final: await fs.readFile(file, 'utf8'),
    operations: (await fs.readdir(dir)).filter((x) =>
      x.startsWith('.cover-update-'),
    ),
  }),
);
const stub = `const {cloudDb,books,bookFiles,authors,bookAuthors,logger,paths,eq}=globalThis.F; const {BOOK_STORAGE_DEFAULTS,buildBookStorageRelativePath,getCanonicalBookPaths,osToPosixPath,posixToOsPath}=paths;`;
let book = { title: 'New', coverImagePath: null };
let fileRows = [
  {
    id: 'f',
    format: 'pdf',
    relativePath: 'library/Author/Old (12345678)/Old.pdf',
  },
];
let updates = [];
const tables = {
  books: { id: 'book-id' },
  bookFiles: { id: 'file-id', bookId: 'book-file' },
  authors: { id: 'author-id', name: 'name' },
  bookAuthors: {
    authorId: 'author-id',
    bookId: 'book-id',
    position: 'position',
  },
};
const db = {
  select() {
    return {
      from(t) {
        let value =
          t === tables.books
            ? [book]
            : t === tables.bookFiles
              ? fileRows
              : [{ name: 'Author', position: 1 }];
        return {
          where() {
            let result = Promise.resolve(value);
            result.limit = async () => value;
            return result;
          },
          innerJoin() {
            return { where: async () => value };
          },
        };
      },
    };
  },
  update() {
    return {
      set(v) {
        return { where: async () => updates.push(v) };
      },
    };
  },
};
const paths = {
  BOOK_STORAGE_DEFAULTS: { baseDir: 'library' },
  getCanonicalBookPaths: () => ({ bookDir: 'library/Author/New (12345678)' }),
  buildBookStorageRelativePath: () => 'library/Author/New (12345678)/New.pdf',
  osToPosixPath: (p) => p.split(path.sep).join('/'),
  posixToOsPath: (p) => p,
};
globalThis.F = {
  cloudDb: db,
  ...tables,
  logger: { warn() {} },
  paths,
  eq: () => true,
};
const m = await load(
  'server/utils/books/storage/move/move-book-storage.ts',
  'move',
  stub,
);
const work = tmp + '/move-fixture';
await fs.mkdir(work, { recursive: true });
process.chdir(work);
async function make(p, data) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, data);
}
const src = work + '/' + fileRows[0].relativePath;
const dest = work + '/library/Author/New (12345678)/New.pdf';
await make(src, 'SOURCE');
await make(dest, 'OTHER');
await m.moveBookStorageToCanonical({
  bookId: '12345678-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
});
console.log(
  'MOVE_COLLISION',
  JSON.stringify({
    sourceExists: await fs.access(src).then(
      () => true,
      () => false,
    ),
    destination: await fs.readFile(dest, 'utf8'),
    updates,
  }),
);
await fs.rm(work + '/library', { recursive: true, force: true });
updates = [];
await make(src, 'SOURCE');
const side = path.dirname(src) + '/side.txt';
await make(side, 'SIDE');
// Existing destination directory causes rename(side.txt,directory) to fail; catch then recursively removes source.
globalThis.failSidecar = true;
await m.moveBookStorageToCanonical({
  bookId: '12345678-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
});
console.log(
  'MOVE_SIDECAR',
  JSON.stringify({
    sideExists: await fs.access(side).then(
      () => true,
      () => false,
    ),
    destinationExists: await fs
      .access(work + '/library/Author/New (12345678)/side.txt')
      .then(
        () => true,
        () => false,
      ),
  }),
);
const dropStub = `const cloudDb={transaction:async()=>{throw new Error('injected database failure')}}; const logger={debug(){}}; const toSafePathSegment=(s)=>s; const buildBookStorageRelativePath=({filename})=>'library/Drop/Book (12345678)/'+filename; const normalizePublishedAt=()=>null; const makeAuthorSortKey=()=>''; const makeTitleSortKey=()=>''; const eq=()=>true; const books={}, authors={},bookAuthors={},bookFiles={},collectionBooks={};`;
const d = await load('server/utils/books/dropbox/ingest.ts', 'drop', dropStub);
const dp = tmp + '/drop-fixture';
await fs.mkdir(dp + '/dropbox', { recursive: true });
process.chdir(dp);
const input = dp + '/dropbox/book.pdf.delb-processing-1';
await fs.writeFile(input, 'ORIGINAL');
let dropError;
try {
  await d.ingestDropboxFile({
    fileAbs: input,
    originalFilename: 'book.pdf',
    target: { ownerUserId: 'u', collectionIds: [] },
  });
} catch (e) {
  dropError = e.message;
}
let destination = dp + '/library/Drop/Book (12345678)/book.pdf';
console.log(
  'DROPBOX',
  JSON.stringify({
    error: dropError,
    inputExists: await fs.access(input).then(
      () => true,
      () => false,
    ),
    destinationExists: await fs.access(destination).then(
      () => true,
      () => false,
    ),
  }),
);
let uploadSrc = await fs.readFile(
  root + '/server/api/books/upload.post.ts',
  'utf8',
);
uploadSrc = uploadSrc.slice(
  uploadSrc.indexOf('async function processOneBookUpload('),
  uploadSrc.indexOf('export default defineEventHandler'),
);
uploadSrc = 'export ' + uploadSrc;
const uploadStub = `const path=(await import('node:path')).default; const {mkdir,writeFile}=await import('node:fs/promises'); const ensureSupportedBookFormat=()=> 'pdf'; const parseBookMetadataFromBuffer=async()=>({title:'Book',author:'Author'}); const deleteBook=async()=>{globalThis.oldDeleted=true}; const toSafePathSegment=s=>s; const buildBookStorageRelativePath=()=> 'library/Book/Book.pdf'; const resolveDataPath=p=>process.cwd()+'/'+p; const createError=x=>new Error(x.statusMessage); const cloudDb={insert(){throw new Error('injected database failure')}}; const books={}; const makeTitleSortKey=()=>'';`;
let js = (
  await esbuild.transform(uploadStub + '\n' + uploadSrc, {
    loader: 'ts',
    format: 'esm',
    target: 'node20',
  })
).code;
await fs.writeFile(tmp + '/upload.mjs', js);
const u = await import(pathToFileURL(tmp + '/upload.mjs').href);
const up = tmp + '/upload-fixture';
await fs.mkdir(up, { recursive: true });
process.chdir(up);
let uploadError;
try {
  await u.processOneBookUpload(
    { filename: 'Book.pdf', data: Buffer.from('NEW') },
    {
      userId: 'u',
      userRole: 'admin',
      collectionIds: [],
      allowDuplicate: true,
      replaceBookId: 'old',
    },
  );
} catch (e) {
  uploadError = e.message;
}
console.log(
  'UPLOAD',
  JSON.stringify({
    error: uploadError,
    oldDeleteCalled: globalThis.oldDeleted,
    newFileExists: await fs.access(up + '/library/Book/Book.pdf').then(
      () => true,
      () => false,
    ),
  }),
);

import { storageRecoveryReady } from '~~/server/utils/books/storage/recovery-ready';

export default defineEventHandler(async () => {
  await storageRecoveryReady;
});

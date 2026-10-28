import { startDropboxIngestWatcher } from '~~/server/utils/books/dropbox/watcher';
import { storageRecoveryReady } from '~~/server/utils/books/storage/recovery-ready';
import { logger } from '~/utils/logger';

export default defineNitroPlugin((nitroApp) => {
  let watcher: ReturnType<typeof startDropboxIngestWatcher> | undefined;
  let closed = false;
  void storageRecoveryReady
    .then(() => {
      if (!closed) watcher = startDropboxIngestWatcher();
    })
    .catch((error) => {
      logger.error(
        error,
        'Storage recovery failed; Dropbox watcher did not start',
      );
    });
  nitroApp.hooks.hook('close', async () => {
    closed = true;
    await watcher?.stop();
  });
});

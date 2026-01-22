import { startDropboxIngestWatcher } from '~~/server/utils/books/dropbox/watcher';

export default defineNitroPlugin((nitroApp) => {
  const watcher = startDropboxIngestWatcher();

  nitroApp.hooks.hook('close', async () => {
    await watcher.stop();
  });
});


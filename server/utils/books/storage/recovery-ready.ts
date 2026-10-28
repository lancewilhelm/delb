import { recoverBookDeletes } from './delete-recovery';
import { recoverBookMoves } from './move-recovery';
import { recoverBookCovers } from './cover-recovery';
import { recoverBookCreates } from './create-recovery';
import { BookStorageLockBusyError } from './book-lock';

export const storageRecoveryReady = (async () => {
  for (;;) {
    try {
      await recoverBookCreates();
      await recoverBookCovers();
      await recoverBookMoves();
      await recoverBookDeletes();
      return;
    } catch (error) {
      if (!(error instanceof BookStorageLockBusyError)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
})();

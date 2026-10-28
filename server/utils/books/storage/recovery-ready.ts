import { recoverBookDeletes } from './delete-recovery';
import { recoverBookMoves } from './move-recovery';
import { recoverBookCovers } from './cover-recovery';

export const storageRecoveryReady = (async () => {
  await recoverBookCovers();
  await recoverBookMoves();
  await recoverBookDeletes();
})();

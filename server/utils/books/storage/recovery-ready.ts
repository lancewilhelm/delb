import { recoverBookDeletes } from './delete-recovery';
import { recoverBookMoves } from './move-recovery';
import { recoverBookCovers } from './cover-recovery';
import { recoverBookCreates } from './create-recovery';

export const storageRecoveryReady = (async () => {
  await recoverBookCreates();
  await recoverBookCovers();
  await recoverBookMoves();
  await recoverBookDeletes();
})();

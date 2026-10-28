import { recoverBookDeletes } from './delete-recovery';
import { recoverBookMoves } from './move-recovery';

export const storageRecoveryReady = (async () => {
  await recoverBookMoves();
  await recoverBookDeletes();
})();

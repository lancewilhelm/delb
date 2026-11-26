/**
 * Export helpers for share cards: download, copy, and the Web Share API.
 * None of them attach a Delb URL, because a library link is private.
 */

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('The card could not be converted to a PNG.'));
    }, 'image/png');
  });
}

export async function downloadPng(
  canvas: HTMLCanvasElement,
  fileName: string,
): Promise<void> {
  const blob = await canvasToPngBlob(canvas);
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Give the browser a moment to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

export function canCopyImage(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function' &&
    typeof ClipboardItem !== 'undefined'
  );
}

/**
 * Copies the card to the clipboard. The ClipboardItem receives a promise
 * instead of a blob: Safari only allows clipboard writes that start during
 * the click, and building the PNG takes longer than that.
 */
export async function copyPng(canvas: HTMLCanvasElement): Promise<void> {
  if (!canCopyImage()) {
    throw new Error('This browser cannot copy images.');
  }
  await navigator.clipboard.write([
    new ClipboardItem({ 'image/png': canvasToPngBlob(canvas) }),
  ]);
}

export function canShareFiles(): boolean {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.share !== 'function' ||
    typeof navigator.canShare !== 'function' ||
    typeof File === 'undefined'
  ) {
    return false;
  }
  try {
    const probe = new File([new Uint8Array(1)], 'card.png', {
      type: 'image/png',
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

/**
 * Opens the system share sheet with the PNG. Returns false when the reader
 * closes the sheet without sharing.
 */
export async function sharePng(
  canvas: HTMLCanvasElement,
  fileName: string,
  title: string,
): Promise<boolean> {
  const blob = await canvasToPngBlob(canvas);
  const file = new File([blob], fileName, { type: 'image/png' });
  try {
    await navigator.share({ files: [file], title });
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    throw err;
  }
}

/** Prefix offsets keep virtual rows aligned when wrapped cells have different heights. */
export function bookListOffsets(
  ids: string[],
  measured: ReadonlyMap<string, number>,
  minimum: number,
): number[] {
  const offsets = [0];
  let total = 0;
  for (const id of ids) {
    total += measured.get(id) ?? Math.max(minimum, 85);
    offsets.push(total);
  }
  return offsets;
}

export function bookListWindow(
  offsets: number[],
  top: number,
  height: number,
  buffer: number,
) {
  const count = Math.max(0, offsets.length - 1);
  function rowAt(position: number) {
    let low = 0;
    let high = count;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((offsets[mid + 1] ?? Infinity) <= position) low = mid + 1;
      else high = mid;
    }
    return low;
  }
  const startIndex = Math.max(0, rowAt(top) - buffer);
  const endIndex = Math.min(count, rowAt(top + height) + 1 + buffer);
  return {
    startIndex,
    endIndex,
    offsetY: offsets[startIndex] ?? 0,
    totalHeight: offsets[count] ?? 0,
  };
}

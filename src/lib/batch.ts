export async function processBatch<T, R>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function next(): Promise<void> {
    while (index < items.length) {
      const currentIndex = index++;
      const result = await processor(items[currentIndex]!);
      results[currentIndex] = result;
    }
  }

  const workers = Array.from(
    { length: Math.min(batchSize, items.length) },
    () => next()
  );
  await Promise.all(workers);

  return results;
}

import pLimit from 'p-limit';

export function createConcurrencyLimiter(concurrency: number) {
  return pLimit(Math.max(1, concurrency));
}

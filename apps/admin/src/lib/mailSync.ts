export function preserveRowsBelowAuthoritativeHead<T extends { id: number }>(
  existing: T[],
  authoritativeHead: T[],
  headPageWasFull: boolean,
): T[] {
  if (authoritativeHead.length === 0) return [];
  if (!headPageWasFull) return [];
  const floor = authoritativeHead.reduce((min, item) => Math.min(min, item.id), Number.POSITIVE_INFINITY);
  return existing.filter((item) => item.id < floor);
}

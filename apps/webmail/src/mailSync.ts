export function reconcileServerMailRange<T extends { id: number }>(
  existing: T[],
  authoritativeIds: ReadonlySet<number>,
  lowestScannedId: number,
  reachedEnd: boolean,
): T[] {
  if (authoritativeIds.size === 0 && !reachedEnd) return existing;
  return existing.filter((mail) => {
    if (authoritativeIds.has(mail.id)) return true;
    if (reachedEnd) return false;
    return mail.id < lowestScannedId;
  });
}

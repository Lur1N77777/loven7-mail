export type MailMode = 'inbox' | 'unknown' | 'sent';

export type RemoteMailStateLike = {
  readIds?: string[];
  starredIds?: string[];
  readAllBefore?: Record<string, number>;
};

export function mailStateMode(mode: MailMode): MailMode {
  return mode === 'unknown' ? 'inbox' : mode;
}

export function storageId(mode: MailMode, id: number): string {
  return `${mailStateMode(mode)}:${id}`;
}

export function stateIdCandidates(mode: MailMode, id: number): string[] {
  const primary = storageId(mode, id);
  if (mailStateMode(mode) !== 'inbox') return [primary];
  return [primary, `unknown:${id}`];
}

export function hasMailStateId(ids: Set<string>, mode: MailMode, id: number): boolean {
  return stateIdCandidates(mode, id).some((key) => ids.has(key));
}

export function deleteMailStateId(ids: Set<string>, mode: MailMode, id: number): void {
  stateIdCandidates(mode, id).forEach((key) => ids.delete(key));
}

export function addMailStateIds(ids: Set<string>, mode: MailMode, id: number): void {
  stateIdCandidates(mode, id).forEach((key) => ids.add(key));
}

export function mergeSets<T>(left: Set<T>, right: Iterable<T>): Set<T> {
  const next = new Set(left);
  for (const item of right) next.add(item);
  return next;
}

export function readAllBeforeValue(value: Record<string, number>, mode: MailMode): number {
  const primary = mailStateMode(mode);
  const legacyInbound = primary === 'inbox' ? Number(value.unknown || 0) || 0 : 0;
  return Math.max(0, Number(value[primary] || 0) || 0, legacyInbound);
}

export function withReadAllBeforeValue(
  value: Record<string, number>,
  mode: MailMode,
  nextValue: number,
): Record<string, number> {
  const primary = mailStateMode(mode);
  const next = { ...value, [primary]: Math.max(0, Number(nextValue || 0) || 0) };
  if (primary === 'inbox') next.unknown = next[primary];
  return next;
}

export function normalizeRemoteIds(ids: string[] | undefined, mode: MailMode): Set<string> {
  return new Set((ids || []).map((id) => {
    const numeric = Number(String(id).split(':').pop() || 0);
    return Number.isInteger(numeric) && numeric > 0 ? storageId(mode, numeric) : '';
  }).filter(Boolean));
}

export function normalizeRemoteMailState(remote: RemoteMailStateLike | null | undefined, mode: MailMode) {
  return {
    readIds: normalizeRemoteIds(remote?.readIds, mode),
    starredIds: normalizeRemoteIds(remote?.starredIds, mode),
    readAllBefore: readAllBeforeValue(remote?.readAllBefore || {}, mode),
  };
}

export function applyMailState<T extends { id: number }>(
  items: T[],
  mode: MailMode,
  readIds: Set<string>,
  starredIds: Set<string>,
  readAllBefore: Record<string, number>,
): Array<T & { isUnread: boolean; isStarred: boolean }> {
  return items.map((mail) => {
    const readByBulk = mail.id <= readAllBeforeValue(readAllBefore, mode);
    return {
      ...mail,
      isUnread: !(hasMailStateId(readIds, mode, mail.id) || readByBulk),
      isStarred: hasMailStateId(starredIds, mode, mail.id),
    };
  });
}

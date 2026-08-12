import {
  mergeSets,
  normalizeRemoteMailState,
  readAllBeforeValue,
  withReadAllBeforeValue,
  type MailMode,
  type RemoteMailStateLike,
} from '../domain/mailState.ts';

export type MailStateSnapshot = {
  readIds: Set<string>;
  starredIds: Set<string>;
  readAllBefore: Record<string, number>;
};

export type MailStateBackfill = {
  readIds: string[];
  starredIds: string[];
  readAllBefore: number;
};

export type MailStateReconciliation = {
  state: MailStateSnapshot;
  backfill: MailStateBackfill | null;
};

export function reconcileMailState(
  local: MailStateSnapshot,
  remote: RemoteMailStateLike | null | undefined,
  mode: MailMode,
): MailStateReconciliation {
  const normalizedRemote = normalizeRemoteMailState(remote, mode);
  const readIds = mergeSets(local.readIds, normalizedRemote.readIds);
  const starredIds = mergeSets(local.starredIds, normalizedRemote.starredIds);
  const localReadAllBefore = readAllBeforeValue(local.readAllBefore, mode);
  const mergedReadAllBefore = Math.max(localReadAllBefore, normalizedRemote.readAllBefore);
  const readAllBefore = withReadAllBeforeValue(local.readAllBefore, mode, mergedReadAllBefore);

  const localHasExtraRead = [...local.readIds].some((id) => !normalizedRemote.readIds.has(id));
  const localHasExtraStar = [...local.starredIds].some((id) => !normalizedRemote.starredIds.has(id));
  const localHasNewerBulk = localReadAllBefore > normalizedRemote.readAllBefore;
  const backfill = localHasExtraRead || localHasExtraStar || localHasNewerBulk
    ? {
        readIds: [...readIds],
        starredIds: [...starredIds],
        readAllBefore: mergedReadAllBefore,
      }
    : null;

  return {
    state: { readIds, starredIds, readAllBefore },
    backfill,
  };
}

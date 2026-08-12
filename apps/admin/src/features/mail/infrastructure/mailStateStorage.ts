import { MAIL_READ_HISTORY_MAX, STORAGE_KEYS } from '../../../lib/constants.ts';
import { readJsonStorage, writeJsonStorage } from '../../../lib/storage.ts';

export const MAIL_STATE_CHANGED_EVENT = 'loven7-mail-state-changed';

export type MailStateStorageKeys = {
  readIds: string;
  readAllBefore: string;
  starredIds: string;
};

export type StoredMailState = {
  readIds: Set<string>;
  readAllBefore: Record<string, number>;
  starredIds: Set<string>;
};

export type MailStatePersistence = Partial<{
  readIds: Iterable<string>;
  readAllBefore: Record<string, number>;
  starredIds: Iterable<string>;
}>;

export type PersistedMailState = Partial<{
  readIds: string[];
  readAllBefore: Record<string, number>;
  starredIds: string[];
}>;

export type MailStateChangedDetail = {
  readIdsKey: string;
  readAllBeforeKey: string;
  starredIdsKey: string;
};

export interface MailStateStoragePort {
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
}

const browserStorage: MailStateStoragePort = {
  read<T>(key: string, fallback: T): T {
    return readJsonStorage(key, fallback);
  },
  write(key: string, value: unknown): void {
    writeJsonStorage(key, value);
  },
};

function mailStateStorageKey(baseKey: string, scope: string): string {
  return `${baseKey}.${scope || 'default'}`;
}

function normalizeStoredIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && Boolean(item));
}

function normalizeWatermarks(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: Record<string, number> = {};
  Object.entries(value as Record<string, unknown>).forEach(([mode, watermark]) => {
    const numeric = Number(watermark);
    if (Number.isFinite(numeric) && numeric >= 0) normalized[mode] = Math.floor(numeric);
  });
  return normalized;
}

function boundedIds(ids: Iterable<string>, maxIds: number): string[] {
  const normalized = [...ids].filter((id) => typeof id === 'string' && Boolean(id));
  const limit = Number.isFinite(maxIds) ? Math.max(0, Math.floor(maxIds)) : MAIL_READ_HISTORY_MAX;
  return limit === 0 ? [] : normalized.slice(-limit);
}

function writeSafely(storage: MailStateStoragePort, key: string, value: unknown): void {
  try {
    storage.write(key, value);
  } catch {
    // Mail state remains usable in memory when browser storage is unavailable.
  }
}

export function getMailStateStorageKeys(scope: string): MailStateStorageKeys {
  return {
    readIds: mailStateStorageKey(STORAGE_KEYS.mailReadIds, scope),
    readAllBefore: mailStateStorageKey(STORAGE_KEYS.mailReadAllBefore, scope),
    starredIds: mailStateStorageKey(STORAGE_KEYS.mailStarredIds, scope),
  };
}

export function readMailState(
  keys: MailStateStorageKeys,
  storage: MailStateStoragePort = browserStorage,
): StoredMailState {
  try {
    return {
      readIds: new Set(normalizeStoredIds(storage.read<unknown>(keys.readIds, []))),
      readAllBefore: normalizeWatermarks(storage.read<unknown>(keys.readAllBefore, {})),
      starredIds: new Set(normalizeStoredIds(storage.read<unknown>(keys.starredIds, []))),
    };
  } catch {
    return { readIds: new Set(), readAllBefore: {}, starredIds: new Set() };
  }
}

export function persistMailState(
  keys: MailStateStorageKeys,
  state: MailStatePersistence,
  storage: MailStateStoragePort = browserStorage,
  maxIds = MAIL_READ_HISTORY_MAX,
): PersistedMailState {
  const persisted: PersistedMailState = {};
  if (state.readIds !== undefined) {
    persisted.readIds = boundedIds(state.readIds, maxIds);
    writeSafely(storage, keys.readIds, persisted.readIds);
  }
  if (state.readAllBefore !== undefined) {
    persisted.readAllBefore = normalizeWatermarks(state.readAllBefore);
    writeSafely(storage, keys.readAllBefore, persisted.readAllBefore);
  }
  if (state.starredIds !== undefined) {
    persisted.starredIds = boundedIds(state.starredIds, maxIds);
    writeSafely(storage, keys.starredIds, persisted.starredIds);
  }
  return persisted;
}

export function mailStateChangedDetail(keys: MailStateStorageKeys): MailStateChangedDetail {
  return {
    readIdsKey: keys.readIds,
    readAllBeforeKey: keys.readAllBefore,
    starredIdsKey: keys.starredIds,
  };
}

export function isSameMailStateScope(detail: unknown, keys: MailStateStorageKeys): boolean {
  if (!detail || typeof detail !== 'object') return false;
  const record = detail as Partial<MailStateChangedDetail>;
  return record.readIdsKey === keys.readIds
    && record.readAllBeforeKey === keys.readAllBefore
    && record.starredIdsKey === keys.starredIds;
}

export function notifyMailStateChanged(keys: MailStateStorageKeys): void {
  if (typeof window === 'undefined' || typeof CustomEvent === 'undefined') return;
  window.dispatchEvent(new CustomEvent(MAIL_STATE_CHANGED_EVENT, {
    detail: mailStateChangedDetail(keys),
  }));
}

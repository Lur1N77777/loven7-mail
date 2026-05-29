export type AppLocale = 'zh-CN' | 'en-US';

const STORAGE_KEY = 'loven7.locale';
export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

let runtimeLocale: AppLocale = DEFAULT_LOCALE;

export function normalizeLocale(value: unknown): AppLocale {
  return String(value || '').toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

export function readInitialLocale(): AppLocale {
  try {
    runtimeLocale = normalizeLocale(localStorage.getItem(STORAGE_KEY));
    return runtimeLocale;
  } catch {
    runtimeLocale = DEFAULT_LOCALE;
    return DEFAULT_LOCALE;
  }
}

export function writeLocale(locale: AppLocale) {
  try {
    localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Ignore storage failures in private mode.
  }
}

export function applyRuntimeLocale(locale: AppLocale) {
  runtimeLocale = normalizeLocale(locale);
  if (typeof document === 'undefined') return;
  document.documentElement.lang = runtimeLocale;
  document.documentElement.dataset.locale = runtimeLocale;
  document.documentElement.dataset.fontMode = runtimeLocale === 'en-US' ? 'en' : 'zh';
}

export function getRuntimeLocale(): AppLocale {
  return runtimeLocale;
}

export function toggleLocale(locale: AppLocale): AppLocale {
  return locale === 'en-US' ? 'zh-CN' : 'en-US';
}

export function localeShortLabel(locale: AppLocale): string {
  return locale === 'en-US' ? 'EN' : '中';
}

import { STORAGE_KEYS } from './constants';
import { readStorage, writeLocalStorage } from './storage';

export type AppLocale = 'zh-CN' | 'en-US';

export const DEFAULT_LOCALE: AppLocale = 'zh-CN';

let runtimeLocale: AppLocale = DEFAULT_LOCALE;

export function normalizeLocale(value: unknown): AppLocale {
  return String(value || '').toLowerCase().startsWith('en') ? 'en-US' : 'zh-CN';
}

export function readInitialLocale(): AppLocale {
  runtimeLocale = normalizeLocale(readStorage(STORAGE_KEYS.uiLocale, DEFAULT_LOCALE));
  return runtimeLocale;
}

export function writeLocale(locale: AppLocale) {
  writeLocalStorage(STORAGE_KEYS.uiLocale, locale);
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

export function isEnglishLocale(locale: AppLocale = runtimeLocale): boolean {
  return locale === 'en-US';
}

export function localeText(zh: string, en: string, locale: AppLocale = runtimeLocale): string {
  return locale === 'en-US' ? en : zh;
}

export function getBackendLang(locale: AppLocale): 'zh' | 'en' {
  return locale === 'en-US' ? 'en' : 'zh';
}

export function toggleLocale(locale: AppLocale): AppLocale {
  return locale === 'en-US' ? 'zh-CN' : 'en-US';
}

export function getLocaleShortLabel(locale: AppLocale): string {
  return locale === 'en-US' ? 'EN' : '中';
}

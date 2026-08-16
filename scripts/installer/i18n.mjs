const LANGUAGE_ALIASES = new Map([
  ['zh', 'zh-CN'],
  ['zh-cn', 'zh-CN'],
  ['zh-hans', 'zh-CN'],
  ['cn', 'zh-CN'],
  ['chinese', 'zh-CN'],
  ['中文', 'zh-CN'],
  ['en', 'en'],
  ['en-us', 'en'],
  ['en-gb', 'en'],
  ['english', 'en'],
]);

export function normalizeInstallerLanguage(value, { fallback = 'zh-CN', strict = true } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const normalized = LANGUAGE_ALIASES.get(raw.toLowerCase());
  if (normalized) return normalized;
  if (!strict) return fallback;
  throw new Error(`不支持的安装器语言：${raw}。请使用 zh-CN 或 en。 / Unsupported installer language: ${raw}. Use zh-CN or en.`);
}

export function readInstallerLanguageOption(values) {
  for (let index = 0; index < values.length; index += 1) {
    const value = String(values[index] || '');
    if (value.startsWith('--lang=')) return value.slice('--lang='.length);
    if (value === '--lang') return String(values[index + 1] || '');
  }
  return '';
}

const commandLineLanguage = readInstallerLanguageOption(process.argv.slice(2));
let activeLanguage = normalizeInstallerLanguage(
  commandLineLanguage || process.env.LOVEN7_MAIL_LANG,
  { strict: false },
);

export function setInstallerLanguage(value) {
  activeLanguage = normalizeInstallerLanguage(value);
  process.env.LOVEN7_MAIL_LANG = activeLanguage;
  return activeLanguage;
}

export function getInstallerLanguage() {
  return activeLanguage;
}

export function isEnglish() {
  return activeLanguage === 'en';
}

export function msg(chinese, english) {
  return isEnglish() ? english : chinese;
}

export function joinList(values) {
  return values.join(isEnglish() ? ', ' : '、');
}

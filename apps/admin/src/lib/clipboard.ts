export async function copyText(value: string): Promise<void> {
  const text = value.trim();
  if (!text) throw new Error('没有可复制的内容');
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some browsers block clipboard.writeText outside secure/user-gesture contexts.
      // Fall back to the temporary textarea path below.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.select();
    const ok = document.execCommand('copy');
    if (!ok) throw new Error('复制失败');
  } finally {
    textarea.remove();
  }
}

export function buildAddressLoginUrl(jwt: string, frontendBase?: string): string {
  const fallback = typeof window !== 'undefined' ? window.location.origin : '';
  const base = (frontendBase || fallback || '').trim().replace(/\/$/, '');
  return `${base || ''}/?JWT=${encodeURIComponent(jwt)}`;
}

export function readJwtFromQuery(search: string): string {
  if (!search) return '';
  const raw = search.startsWith('?') ? search.slice(1) : search;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    const key = eq === -1 ? part : part.slice(0, eq);
    const value = eq === -1 ? '' : part.slice(eq + 1);
    if (key === 'JWT' || key === 'jwt') {
      try {
        return decodeURIComponent(value).trim();
      } catch {
        return value.trim();
      }
    }
  }
  return '';
}

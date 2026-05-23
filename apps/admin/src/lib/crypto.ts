export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isLikelyJwt(value: string): boolean {
  if (!value) return false;
  const parts = value.split('.');
  if (parts.length !== 3) return false;
  return parts.every((segment) => segment.length > 0 && JWT_SEGMENT_PATTERN.test(segment));
}

export function jwtExpired(value: string): boolean {
  if (!isLikelyJwt(value)) return false;
  try {
    const payload = JSON.parse(atob(value.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    if (typeof payload?.exp !== 'number') return false;
    return payload.exp * 1000 < Date.now();
  } catch {
    return false;
  }
}

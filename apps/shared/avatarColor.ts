const FALLBACK_AVATAR_COLORS = [
  '#64748B', // slate
  '#58778A', // steel blue
  '#5F7D75', // muted teal
  '#687A5D', // sage
  '#7C7659', // olive
  '#8A6F68', // dusty rose
  '#7B6F8E', // muted violet
  '#6D788F', // blue gray
  '#806B7A', // mauve
  '#6D7C72', // eucalyptus
  '#597B7E', // muted cyan
  '#74805E', // moss
  '#846B76', // muted berry
  '#667390', // muted indigo
  '#8B6E78', // dusty pink
  '#627E68', // muted green
] as const;

export function getFallbackAvatarColor(sender?: string, senderName?: string): string {
  const key = String(sender || senderName || 'mail').trim().toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return FALLBACK_AVATAR_COLORS[(hash >>> 0) % FALLBACK_AVATAR_COLORS.length];
}

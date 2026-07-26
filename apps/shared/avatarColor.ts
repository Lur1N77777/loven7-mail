const FALLBACK_AVATAR_COLORS = [
  '#D26F7C', // raspberry cream
  '#6F91C9', // powder blue
  '#58A38A', // mint macaron
  '#8D7BC2', // lavender cream
  '#D18468', // peach macaron
  '#82A05F', // pistachio
  '#C875A4', // berry cream
  '#55A0AC', // aqua macaron
  '#D7788B', // rose cream
  '#788FC0', // periwinkle
  '#69A071', // matcha cream
  '#7187C5', // blueberry macaron
  '#BD7E91', // mauve cream
  '#8B7EB2', // violet cream
  '#5A99A5', // blue mint
  '#70A092', // eucalyptus
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

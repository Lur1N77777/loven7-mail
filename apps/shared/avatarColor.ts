const FALLBACK_AVATAR_COLORS = [
  '#A95769', // raspberry macaron
  '#527AA2', // powder blue
  '#4B7F6B', // mint macaron
  '#786397', // lavender
  '#A35F6C', // peach macaron
  '#56795E', // pistachio
  '#98597F', // berry cream
  '#417F8C', // aqua macaron
  '#A65F6C', // rose cream
  '#607796', // periwinkle
  '#4D7F5E', // matcha cream
  '#5D73A5', // blueberry macaron
  '#9B6572', // mauve cream
  '#70688F', // violet cream
  '#467480', // blue mint
  '#5E7D75', // eucalyptus
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

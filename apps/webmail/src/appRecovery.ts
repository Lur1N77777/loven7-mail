const CHUNK_LOAD_PATTERN = /(?:chunkloaderror|loading chunk [\w-]+ failed|failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module)/i;

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const candidate = error as { name?: unknown; message?: unknown; reason?: unknown };
  const message = [candidate.name, candidate.message, candidate.reason, String(error)]
    .filter(Boolean)
    .join(" ");
  return CHUNK_LOAD_PATTERN.test(message);
}

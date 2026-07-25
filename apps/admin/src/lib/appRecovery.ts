const CHUNK_LOAD_PATTERN = /(?:chunkloaderror|loading chunk [\w-]+ failed|failed to fetch dynamically imported module|importing a module script failed|error loading dynamically imported module)/i;
const WORKER_ACTIVATION_FALLBACK_MS = 4_000;

type WaitingServiceWorker = {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
  postMessage(message: unknown): void;
};

type ReloadScheduler = (callback: () => void, delay: number) => void;

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const candidate = error as { name?: unknown; message?: unknown; reason?: unknown };
  const message = [candidate.name, candidate.message, candidate.reason, String(error)]
    .filter(Boolean)
    .join(' ');
  return CHUNK_LOAD_PATTERN.test(message);
}

export function activateWaitingServiceWorker(
  worker: WaitingServiceWorker | null | undefined,
  reload: () => void,
  scheduleReload: ReloadScheduler,
): boolean {
  if (!worker) return false;
  let reloaded = false;
  const reloadOnce = () => {
    if (reloaded) return;
    reloaded = true;
    reload();
  };
  worker.addEventListener('statechange', () => {
    if (worker.state === 'activated') reloadOnce();
  });
  worker.postMessage({ type: 'SKIP_WAITING' });
  scheduleReload(reloadOnce, WORKER_ACTIVATION_FALLBACK_MS);
  return true;
}

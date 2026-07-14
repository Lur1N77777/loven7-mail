export const ADDRESS_INDEX_PAGE_SIZE = 500;
export const ADDRESS_INDEX_MAX_ROWS = 2_000;

export type AddressIndexPage<T> = {
  results?: T[];
  count?: number;
};

export type BoundedAddressIndex<T> = {
  results: T[];
  reportedCount: number;
  complete: boolean;
  truncated: boolean;
};

type LoadBoundedAddressIndexOptions<T> = {
  fetchPage: (offset: number, limit: number, signal?: AbortSignal) => Promise<AddressIndexPage<T>>;
  pageSize?: number;
  maxRows?: number;
  signal?: AbortSignal;
};

function positiveInteger(value: number | undefined, fallback: number): number {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : fallback;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new DOMException('Address index loading was cancelled', 'AbortError');
}

/**
 * Builds the optional client-side quick-search index within a strict row budget.
 * Server-side search remains authoritative; this index only improves perceived latency.
 */
export async function loadBoundedAddressIndex<T>({
  fetchPage,
  pageSize = ADDRESS_INDEX_PAGE_SIZE,
  maxRows = ADDRESS_INDEX_MAX_ROWS,
  signal,
}: LoadBoundedAddressIndexOptions<T>): Promise<BoundedAddressIndex<T>> {
  const normalizedPageSize = positiveInteger(pageSize, ADDRESS_INDEX_PAGE_SIZE);
  const normalizedMaxRows = positiveInteger(maxRows, ADDRESS_INDEX_MAX_ROWS);
  const results: T[] = [];
  let reportedCount = 0;
  let complete = false;

  for (let offset = 0; results.length < normalizedMaxRows; offset += normalizedPageSize) {
    throwIfAborted(signal);
    const limit = Math.min(normalizedPageSize, normalizedMaxRows - results.length);
    const page = await fetchPage(offset, limit, signal);
    throwIfAborted(signal);
    const pageRows = Array.isArray(page?.results) ? page.results : [];
    const acceptedRows = pageRows.slice(0, limit);
    results.push(...acceptedRows);

    const pageCount = Number(page?.count);
    if (Number.isFinite(pageCount) && pageCount >= 0) reportedCount = Math.max(reportedCount, pageCount);

    if (
      pageRows.length === 0
      || pageRows.length < limit
      || (reportedCount > 0 && results.length >= reportedCount)
    ) {
      complete = true;
      break;
    }
  }

  reportedCount = Math.max(reportedCount, results.length);
  return {
    results,
    reportedCount,
    complete,
    truncated: !complete && (results.length >= normalizedMaxRows || reportedCount > results.length),
  };
}

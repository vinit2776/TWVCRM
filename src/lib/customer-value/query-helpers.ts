/**
 * Paged, chunked reads for the Customer Value snapshot loader.
 *
 * Two limits shape every read in a batch job:
 *  - PostgREST returns at most 1,000 rows per request and does not say when it
 *    stopped early, so a list that can pass 1,000 rows must be paged or the
 *    result is silently incomplete.
 *  - An `in (...)` filter with hundreds of ids makes the URL too long, so ids go
 *    in chunks.
 *
 * Callers must `order` by a unique column so pages never overlap or skip.
 */

export const PAGE_SIZE = 1000;
export const ID_CHUNK = 100;

export interface QueryError {
  message: string;
  code?: string;
}

export interface PageResult<T> {
  data: T[] | null;
  error: QueryError | null;
}

/** A failed read, with the Postgres/PostgREST code kept so callers can tell "table missing" from "broken". */
export class SnapshotQueryError extends Error {
  readonly code: string | undefined;
  constructor(label: string, error: QueryError) {
    super(`${label}: ${error.message}`);
    this.name = "SnapshotQueryError";
    this.code = error.code;
  }
}

/** True when the error means the table does not exist in this database (never run, or migration not applied). */
export function isMissingTableError(err: unknown): boolean {
  if (!(err instanceof SnapshotQueryError)) return false;
  return (
    err.code === "42P01" ||
    err.code === "PGRST205" ||
    /does not exist|schema cache/i.test(err.message)
  );
}

/** True when the error means a column does not exist yet (a migration not applied in this database). */
export function isMissingColumnError(err: unknown): boolean {
  if (!(err instanceof SnapshotQueryError)) return false;
  return err.code === "42703" || /column .* does not exist/i.test(err.message);
}

/** Reads every page of a query. `build` gets an inclusive row range and returns that page. */
export async function fetchAllPages<T>(
  label: string,
  build: (from: number, to: number) => PromiseLike<PageResult<T>>
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) throw new SnapshotQueryError(label, error);
    const page = data ?? [];
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

/** Like `fetchAllPages`, for an `in (...)` lookup: ids are split into chunks, each chunk fully paged. */
export async function fetchInChunks<T>(
  label: string,
  ids: string[],
  build: (batch: string[], from: number, to: number) => PromiseLike<PageResult<T>>,
  chunkSize: number = ID_CHUNK
): Promise<T[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += chunkSize) chunks.push(unique.slice(i, i + chunkSize));
  const results = await Promise.all(
    chunks.map((batch) => fetchAllPages<T>(label, (from, to) => build(batch, from, to)))
  );
  return results.flat();
}

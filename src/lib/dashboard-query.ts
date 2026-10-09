import type { createAdminClient } from "@/lib/supabase/server";

/**
 * Query helpers for dashboard widgets that aggregate whole-year data.
 * PostgREST caps a response at 1000 rows and a long `.in()` list overflows the
 * URL, so large reads must page and chunk — a plain select would silently
 * truncate and under-report.
 */

type Admin = Awaited<ReturnType<typeof createAdminClient>>;
export type DashRow = Record<string, unknown>;

const CHUNK = 150;

/** Rows for `ids` matched on `key`, fetched in URL-safe chunks. */
export async function fetchByIds(admin: Admin, table: string, select: string, ids: string[], key = "id"): Promise<DashRow[]> {
  const uniq = [...new Set(ids)];
  const out: DashRow[] = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await admin.from(table).select(select).in(key, uniq.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as unknown as DashRow[]));
  }
  return out;
}

export const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** `YYYY-MM` of a timestamp as seen in IST — the business's calendar, not the server's. */
export function istMonthKey(ts: string): string {
  return new Date(new Date(ts).getTime() + 5.5 * 3_600_000).toISOString().slice(0, 7);
}

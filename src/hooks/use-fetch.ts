"use client";

import { useState, useEffect, useCallback, useRef } from "react";

/* ------------------------------------------------------------------ */
/*  useFetch — generic data-fetching hook with AbortController        */
/* ------------------------------------------------------------------ */

interface UseFetchOptions<T> {
  /** Query-string params — falsy values are omitted automatically. */
  params?: Record<string, string | number | boolean | undefined | null>;
  /** Set `false` to defer the initial fetch (useful for conditional loads). */
  enabled?: boolean;
  /** Value to use before the first successful fetch (default: `undefined`). */
  initialData?: T;
  /** Transform the raw JSON before storing it (default: `json => json.data`). */
  select?: (json: Record<string, unknown>) => T;
  /** Called after every successful fetch. */
  onSuccess?: (data: T) => void;
}

interface UseFetchReturn<T> {
  data: T;
  loading: boolean;
  error: string | null;
  /** Re-run the fetch (creates a fresh AbortController). */
  refetch: () => void;
}

/**
 * Minimal data-fetching hook that:
 * - builds a URL from `url` + `params`
 * - aborts in-flight requests on unmount or dependency change
 * - de-dupes state updates after abort
 *
 * @example
 * const { data, loading } = useFetch<Lead[]>("/api/leads", {
 *   params: { page: 1, status: "active", search },
 * });
 */
export function useFetch<T>(
  url: string,
  options: UseFetchOptions<T> = {},
): UseFetchReturn<T> {
  const {
    params,
    enabled = true,
    initialData,
    select = (json: Record<string, unknown>) => json.data as T,
    onSuccess,
  } = options;

  const [data, setData] = useState<T>(initialData as T);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  // Keep a stable reference to onSuccess / select so they don't trigger refetches.
  const selectRef = useRef(select);
  selectRef.current = select;
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  // Serialise params into a stable string for the dependency array.
  const paramString = params
    ? Object.entries(params)
        .filter(([, v]) => v != null && v !== "" && v !== false)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join("&")
    : "";

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      setLoading(true);
      setError(null);

      const fullUrl = paramString ? `${url}?${paramString}` : url;

      try {
        const res = await fetch(fullUrl, { signal });
        if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
        const json = await res.json();

        if (signal.aborted) return;

        const selected = selectRef.current(json);
        setData(selected);
        onSuccessRef.current?.(selected);
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [url, paramString],
  );

  // Track current controller so `refetch()` can abort + re-fire.
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData, enabled]);

  const refetch = useCallback(() => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    fetchData(controller.signal);
  }, [fetchData]);

  return { data, loading, error, refetch };
}

/* ------------------------------------------------------------------ */
/*  usePaginatedFetch — adds pagination to useFetch                   */
/* ------------------------------------------------------------------ */

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface UsePaginatedFetchReturn<T> extends UseFetchReturn<T[]> {
  pagination: Pagination;
}

/**
 * Like `useFetch`, but expects the API to return `{ data, pagination }`.
 *
 * @example
 * const { data, pagination, loading } = usePaginatedFetch<Lead>("/api/leads", {
 *   params: { page, status, search },
 * });
 */
export function usePaginatedFetch<T>(
  url: string,
  options: Omit<UseFetchOptions<T[]>, "select"> & {
    params?: Record<string, string | number | boolean | undefined | null>;
  } = {},
): UsePaginatedFetchReturn<T> {
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });

  const result = useFetch<T[]>(url, {
    ...options,
    select: (json: Record<string, unknown>) => {
      if (json.pagination) setPagination(json.pagination as Pagination);
      return (json.data ?? []) as T[];
    },
  });

  return { ...result, data: result.data ?? [], pagination };
}

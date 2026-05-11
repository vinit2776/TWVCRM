"use client";

import { useFetch, usePaginatedFetch } from "./use-fetch";
import type { Aggregator } from "@/types";

interface UseAggregatorsOptions {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  sort_by?: string;
  sort_order?: "asc" | "desc";
}

export function useAggregators(options: UseAggregatorsOptions = {}) {
  return usePaginatedFetch<Aggregator>("/api/aggregators", {
    params: {
      page: options.page,
      limit: options.limit,
      status: options.status,
      search: options.search,
      sort_by: options.sort_by,
      sort_order: options.sort_order,
    },
  });
}

export function useAggregator(id: string) {
  return useFetch<Aggregator | null>(`/api/aggregators/${id}`);
}

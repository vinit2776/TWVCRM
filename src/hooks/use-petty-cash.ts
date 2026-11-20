"use client";

import { useFetch, usePaginatedFetch } from "./use-fetch";
import type {
  PettyCashBook,
  PettyCashRequest,
  PettyCashEntry,
  PettyCashCategory,
} from "@/types";
import type { PettyCashAnalytics } from "@/lib/petty-cash-analytics";

// ─── Books ────────────────────────────────────────────────────────────────────

export function usePettyCashBooks(options: { all?: boolean } = {}) {
  return useFetch<PettyCashBook[]>("/api/petty-cash/books", {
    params: { all: options.all || undefined },
    initialData: [],
    select: (json) => (json.data as PettyCashBook[]) ?? [],
  });
}

// ─── Requests ─────────────────────────────────────────────────────────────────

interface UseRequestsOptions {
  page?: number;
  limit?: number;
  status?: string;
  bookId?: string;
  my?: boolean;
}

export function usePettyCashRequests(options: UseRequestsOptions = {}) {
  return usePaginatedFetch<PettyCashRequest>("/api/petty-cash/requests", {
    params: {
      page: options.page,
      limit: options.limit,
      status: options.status,
      book_id: options.bookId,
      my: options.my || undefined,
    },
  });
}

// ─── Entries ──────────────────────────────────────────────────────────────────

interface UseEntriesOptions {
  page?: number;
  limit?: number;
  status?: string;
  bookId?: string;
  categoryId?: string;
  dateFrom?: string;
  dateTo?: string;
  my?: boolean;
}

export function usePettyCashEntries(options: UseEntriesOptions = {}) {
  return usePaginatedFetch<PettyCashEntry>("/api/petty-cash/entries", {
    params: {
      page: options.page,
      limit: options.limit,
      status: options.status,
      book_id: options.bookId,
      category_id: options.categoryId,
      date_from: options.dateFrom,
      date_to: options.dateTo,
      my: options.my || undefined,
    },
  });
}

// ─── Analytics ─────────────────────────────────────────────────────────────────

export interface PettyCashAnalyticsFilters {
  dateFrom?: string;
  dateTo?: string;
  personId?: string;
  categoryId?: string;
  locationId?: string;
}

export interface PettyCashAnalyticsResponse {
  data: PettyCashAnalytics;
  options: { people: { id: string; name: string }[]; locations: { id: string; name: string }[] };
  cashInHand: { total: number; books: number; lowBooks: number } | null;
  truncated: boolean;
  scope: "all" | "own";
}

export function pettyCashAnalyticsParams(f: PettyCashAnalyticsFilters) {
  return {
    date_from: f.dateFrom,
    date_to: f.dateTo,
    person_id: f.personId,
    category_id: f.categoryId,
    location_id: f.locationId,
  };
}

export function usePettyCashAnalytics(filters: PettyCashAnalyticsFilters) {
  return useFetch<PettyCashAnalyticsResponse | null>("/api/petty-cash/analytics", {
    params: pettyCashAnalyticsParams(filters),
    initialData: null,
    select: (json) => json as unknown as PettyCashAnalyticsResponse,
  });
}

// ─── Categories ───────────────────────────────────────────────────────────────

export function usePettyCashCategories() {
  return useFetch<PettyCashCategory[]>("/api/petty-cash/categories", {
    initialData: [],
    select: (json) => (json.data as PettyCashCategory[]) ?? [],
  });
}

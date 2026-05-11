"use client";

import { useFetch, usePaginatedFetch } from "./use-fetch";
import type {
  PettyCashBook,
  PettyCashRequest,
  PettyCashEntry,
  PettyCashCategory,
} from "@/types";

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

// ─── Categories ───────────────────────────────────────────────────────────────

export function usePettyCashCategories() {
  return useFetch<PettyCashCategory[]>("/api/petty-cash/categories", {
    initialData: [],
    select: (json) => (json.data as PettyCashCategory[]) ?? [],
  });
}

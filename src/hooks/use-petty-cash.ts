"use client";

import { useState, useEffect, useCallback } from "react";
import type {
  PettyCashBook,
  PettyCashRequest,
  PettyCashEntry,
  PettyCashCategory,
  PaginatedResponse,
} from "@/types";

// ─── Books ────────────────────────────────────────────────────────────────────

export function usePettyCashBooks(options: { all?: boolean } = {}) {
  const [data, setData] = useState<PettyCashBook[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchBooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (options.all) params.set("all", "true");
      const res = await fetch(`/api/petty-cash/books?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch books");
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [options.all]);

  useEffect(() => { fetchBooks(); }, [fetchBooks]);
  return { data, loading, error, refetch: fetchBooks };
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
  const [data, setData] = useState<PettyCashRequest[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (options.page) params.set("page", String(options.page));
      if (options.limit) params.set("limit", String(options.limit));
      if (options.status) params.set("status", options.status);
      if (options.bookId) params.set("book_id", options.bookId);
      if (options.my) params.set("my", "true");

      const res = await fetch(`/api/petty-cash/requests?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch requests");
      const json: PaginatedResponse<PettyCashRequest> = await res.json();
      setData(json.data);
      setPagination(json.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [options.page, options.limit, options.status, options.bookId, options.my]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);
  return { data, pagination, loading, error, refetch: fetchRequests };
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
  const [data, setData] = useState<PettyCashEntry[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (options.page) params.set("page", String(options.page));
      if (options.limit) params.set("limit", String(options.limit));
      if (options.status) params.set("status", options.status);
      if (options.bookId) params.set("book_id", options.bookId);
      if (options.categoryId) params.set("category_id", options.categoryId);
      if (options.dateFrom) params.set("date_from", options.dateFrom);
      if (options.dateTo) params.set("date_to", options.dateTo);
      if (options.my) params.set("my", "true");

      const res = await fetch(`/api/petty-cash/entries?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch entries");
      const json: PaginatedResponse<PettyCashEntry> = await res.json();
      setData(json.data);
      setPagination(json.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [options.page, options.limit, options.status, options.bookId, options.categoryId, options.dateFrom, options.dateTo, options.my]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);
  return { data, pagination, loading, error, refetch: fetchEntries };
}

// ─── Categories ───────────────────────────────────────────────────────────────

export function usePettyCashCategories() {
  const [data, setData] = useState<PettyCashCategory[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchCategories = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/petty-cash/categories");
      if (!res.ok) throw new Error("Failed to fetch categories");
      const json = await res.json();
      setData(json.data);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchCategories(); }, [fetchCategories]);
  return { data, loading, refetch: fetchCategories };
}

"use client";

import { useState, useEffect, useCallback } from "react";
import type { Aggregator, PaginatedResponse } from "@/types";

interface UseAggregatorsOptions {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
  sort_by?: string;
  sort_order?: "asc" | "desc";
}

export function useAggregators(options: UseAggregatorsOptions = {}) {
  const [data, setData] = useState<Aggregator[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAggregators = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (options.page) params.set("page", String(options.page));
    if (options.limit) params.set("limit", String(options.limit));
    if (options.status) params.set("status", options.status);
    if (options.search) params.set("search", options.search);
    if (options.sort_by) params.set("sort_by", options.sort_by);
    if (options.sort_order) params.set("sort_order", options.sort_order);

    try {
      const res = await fetch(`/api/aggregators?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch aggregators");

      const json: PaginatedResponse<Aggregator> = await res.json();
      setData(json.data);
      setPagination(json.pagination);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [
    options.page,
    options.limit,
    options.status,
    options.search,
    options.sort_by,
    options.sort_order,
  ]);

  useEffect(() => {
    fetchAggregators();
  }, [fetchAggregators]);

  return { data, pagination, loading, error, refetch: fetchAggregators };
}

export function useAggregator(id: string) {
  const [data, setData] = useState<Aggregator | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAggregator = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/aggregators/${id}`);
      if (!res.ok) throw new Error("Failed to fetch aggregator");
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchAggregator();
  }, [fetchAggregator]);

  return { data, loading, error, refetch: fetchAggregator };
}

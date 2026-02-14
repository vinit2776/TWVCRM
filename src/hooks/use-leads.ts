"use client";

import { useState, useEffect, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Lead, PaginatedResponse } from "@/types";

interface UseLeadsOptions {
  page?: number;
  limit?: number;
  status?: string;
  source?: string;
  search?: string;
  assigned_to?: string;
  rating?: string;
  sort_by?: string;
  sort_order?: "asc" | "desc";
}

export function useLeads(options: UseLeadsOptions = {}) {
  const [data, setData] = useState<Lead[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLeads = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (options.page) params.set("page", String(options.page));
    if (options.limit) params.set("limit", String(options.limit));
    if (options.status) params.set("status", options.status);
    if (options.source) params.set("source", options.source);
    if (options.search) params.set("search", options.search);
    if (options.assigned_to) params.set("assigned_to", options.assigned_to);
    if (options.rating) params.set("rating", options.rating);
    if (options.sort_by) params.set("sort_by", options.sort_by);
    if (options.sort_order) params.set("sort_order", options.sort_order);

    try {
      const res = await fetch(`/api/leads?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch leads");

      const json: PaginatedResponse<Lead> = await res.json();
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
    options.source,
    options.search,
    options.assigned_to,
    options.rating,
    options.sort_by,
    options.sort_order,
  ]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  return { data, pagination, loading, error, refetch: fetchLeads };
}

export function useLead(id: string) {
  const [data, setData] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchLead = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/leads/${id}`);
      if (!res.ok) throw new Error("Failed to fetch lead");
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchLead();
  }, [fetchLead]);

  return { data, loading, error, refetch: fetchLead };
}

export function useUsers() {
  const [users, setUsers] = useState<
    { id: string; full_name: string; email: string }[]
  >([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchUsers = async () => {
      const supabase = createClient();
      const { data } = await supabase
        .from("users")
        .select("id, full_name, email")
        .eq("is_active", true)
        .order("full_name");

      setUsers(data || []);
      setLoading(false);
    };
    fetchUsers();
  }, []);

  return { users, loading };
}

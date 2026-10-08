"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { useFetch, usePaginatedFetch } from "./use-fetch";
import type { Lead } from "@/types";

interface UseLeadsOptions {
  page?: number;
  limit?: number;
  status?: string;
  source?: string;
  search?: string;
  assigned_to?: string;
  rating?: string;
  location_id?: string;
  sort_by?: string;
  sort_order?: "asc" | "desc";
  include_archived?: boolean;
  view?: "overdue" | "all";
}

export function useLeads(options: UseLeadsOptions = {}) {
  return usePaginatedFetch<Lead>("/api/leads", {
    params: {
      page: options.page,
      limit: options.limit,
      status: options.status,
      source: options.source,
      search: options.search,
      assigned_to: options.assigned_to,
      rating: options.rating,
      location_id: options.location_id,
      sort_by: options.sort_by,
      sort_order: options.sort_order,
      include_archived: options.include_archived || undefined,
      view: options.view,
    },
  });
}

export function useLead(id: string) {
  return useFetch<Lead | null>(`/api/leads/${id}`);
}

export function useUsers() {
  const [users, setUsers] = useState<
    { id: string; full_name: string; email: string }[]
  >([]);
  const [loading, setLoading] = useState(true);

  const fetchUsers = useCallback(async () => {
    const supabase = createClient();
    const { data } = await supabase
      .from("users")
      .select("id, full_name, email")
      .eq("is_active", true)
      .order("full_name");
    setUsers(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  return { users, loading };
}

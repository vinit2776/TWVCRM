"use client";

import { useState, useEffect, useCallback } from "react";
import type { VoCase, CaseDocument, CaseComment, CaseComplianceCheck, PaginatedResponse } from "@/types";

interface UseCasesOptions {
  page?: number;
  limit?: number;
  status?: string;
  aggregator_id?: string;
  purpose?: string;
  location_id?: string;
  assigned_to?: string;
  search?: string;
  sort_by?: string;
  sort_order?: "asc" | "desc";
}

export function useCases(options: UseCasesOptions = {}) {
  const [data, setData] = useState<VoCase[]>([]);
  const [pagination, setPagination] = useState({
    page: 1,
    limit: 25,
    total: 0,
    totalPages: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCases = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams();
    if (options.page) params.set("page", String(options.page));
    if (options.limit) params.set("limit", String(options.limit));
    if (options.status) params.set("status", options.status);
    if (options.aggregator_id) params.set("aggregator_id", options.aggregator_id);
    if (options.purpose) params.set("purpose", options.purpose);
    if (options.location_id) params.set("location_id", options.location_id);
    if (options.assigned_to) params.set("assigned_to", options.assigned_to);
    if (options.search) params.set("search", options.search);
    if (options.sort_by) params.set("sort_by", options.sort_by);
    if (options.sort_order) params.set("sort_order", options.sort_order);

    try {
      const res = await fetch(`/api/cases?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to fetch cases");

      const json: PaginatedResponse<VoCase> = await res.json();
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
    options.aggregator_id,
    options.purpose,
    options.location_id,
    options.assigned_to,
    options.search,
    options.sort_by,
    options.sort_order,
  ]);

  useEffect(() => {
    fetchCases();
  }, [fetchCases]);

  return { data, pagination, loading, error, refetch: fetchCases };
}

export function useCase(id: string) {
  const [data, setData] = useState<VoCase | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCase = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${id}`);
      if (!res.ok) throw new Error("Failed to fetch case");
      const json = await res.json();
      setData(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchCase();
  }, [fetchCase]);

  return { data, loading, error, refetch: fetchCase };
}

export function useCaseDocuments(caseId: string) {
  const [data, setData] = useState<CaseDocument[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/documents`);
      if (!res.ok) throw new Error("Failed to fetch documents");
      const json = await res.json();
      setData(json.data || []);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchDocs();
  }, [fetchDocs]);

  return { data, loading, refetch: fetchDocs };
}

export function useCaseComments(caseId: string) {
  const [data, setData] = useState<CaseComment[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);

  const fetchComments = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/comments`);
      if (!res.ok) throw new Error("Failed to fetch comments");
      const json = await res.json();
      setData(json.data || []);
      if (json.pagination) setPagination(json.pagination);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchComments();
  }, [fetchComments]);

  return { data, pagination, loading, refetch: fetchComments };
}

export function useCaseCompliance(caseId: string) {
  const [data, setData] = useState<CaseComplianceCheck[]>([]);
  const [summary, setSummary] = useState<{
    total: number;
    passed: number;
    failed: number;
    waived: number;
    pending: number;
    allPassed: boolean;
  }>({ total: 0, passed: 0, failed: 0, waived: 0, pending: 0, allPassed: false });
  const [loading, setLoading] = useState(true);

  const fetchCompliance = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/compliance`);
      if (!res.ok) throw new Error("Failed to fetch compliance");
      const json = await res.json();
      setData(json.data || []);
      if (json.summary) setSummary(json.summary);
    } catch {
      setData([]);
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    fetchCompliance();
  }, [fetchCompliance]);

  return { data, summary, loading, refetch: fetchCompliance };
}

"use client";

import { useState } from "react";
import { useFetch, usePaginatedFetch } from "./use-fetch";
import type { VoCase, CaseDocument, CaseComment, CaseComplianceCheck } from "@/types";

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
  /** Only live agreements whose term ends within N days, including past. */
  expiring_within?: number;
}

export function useCases(options: UseCasesOptions = {}) {
  return usePaginatedFetch<VoCase>("/api/cases", {
    params: {
      page: options.page,
      limit: options.limit,
      status: options.status,
      aggregator_id: options.aggregator_id,
      purpose: options.purpose,
      location_id: options.location_id,
      assigned_to: options.assigned_to,
      search: options.search,
      sort_by: options.sort_by,
      sort_order: options.sort_order,
      expiring_within: options.expiring_within,
    },
  });
}

export function useCase(id: string) {
  return useFetch<VoCase | null>(`/api/cases/${id}`);
}

export function useCaseDocuments(caseId: string) {
  const result = useFetch<CaseDocument[]>(`/api/cases/${caseId}/documents`, {
    initialData: [],
    select: (json) => (json.data as CaseDocument[]) || [],
  });
  return { ...result, data: result.data ?? [] };
}

export function useCaseComments(caseId: string) {
  const [pagination, setPagination] = useState({ page: 1, limit: 50, total: 0, totalPages: 0 });
  const result = useFetch<CaseComment[]>(`/api/cases/${caseId}/comments`, {
    initialData: [],
    select: (json) => {
      if (json.pagination) setPagination(json.pagination as typeof pagination);
      return (json.data as CaseComment[]) || [];
    },
  });
  return { ...result, data: result.data ?? [], pagination };
}

export function useCaseCompliance(caseId: string) {
  const [summary, setSummary] = useState<{
    total: number;
    passed: number;
    failed: number;
    waived: number;
    pending: number;
    allPassed: boolean;
  }>({ total: 0, passed: 0, failed: 0, waived: 0, pending: 0, allPassed: false });

  const result = useFetch<CaseComplianceCheck[]>(`/api/cases/${caseId}/compliance`, {
    initialData: [],
    select: (json) => {
      if (json.summary) setSummary(json.summary as typeof summary);
      return (json.data as CaseComplianceCheck[]) || [];
    },
  });
  return { ...result, data: result.data ?? [], summary };
}

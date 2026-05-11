"use client";

import { useFetch } from "./use-fetch";
import type { Activity } from "@/types";

export function useActivities(leadId: string) {
  const result = useFetch<Activity[]>(`/api/leads/${leadId}/activities`, {
    initialData: [],
    select: (json) => (json.data as Activity[]) || [],
  });
  return { ...result, data: result.data ?? [] };
}

"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

const FORM_TAGS = ["google-ads-form", "meta-ads-form", "walkin-form"];
const LS_KEY = "twv_last_seen_reenquiry";
const SOURCE_LABEL: Record<string, string> = {
  "google-ads-form":  "Google Ads",
  "meta-ads-form":    "Meta Ads",
  "walkin-form":      "Walk-in",
};

export interface EnquiryNotificationItem {
  type: "lead" | "activity";
  leadId: string;
  name: string;
  source: string;
  time: string; // ISO timestamp
}

export function useEnquiryNotifications() {
  const router = useRouter();
  const [newLeadCount, setNewLeadCount]       = useState(0);
  const [reEnquiryCount, setReEnquiryCount]   = useState(0);
  const [recentItems, setRecentItems]         = useState<EnquiryNotificationItem[]>([]);

  const totalCount = newLeadCount + reEnquiryCount;

  const getLastSeen = () => {
    try {
      return localStorage.getItem(LS_KEY) || new Date(0).toISOString();
    } catch {
      return new Date(0).toISOString();
    }
  };

  const markReEnquiriesSeen = useCallback(() => {
    try {
      localStorage.setItem(LS_KEY, new Date().toISOString());
    } catch { /* ignore */ }
    setReEnquiryCount(0);
    setRecentItems((prev) => prev.filter((i) => i.type !== "activity"));
  }, []);

  useEffect(() => {
    const supabase = createClient();
    const lastSeen = getLastSeen();

    async function loadInitialData() {
      // 1. Count unactioned new leads from public forms
      const { count: leadCount } = await supabase
        .from("leads")
        .select("id", { count: "exact", head: true })
        .eq("status", "new")
        .overlaps("tags", FORM_TAGS);

      setNewLeadCount(leadCount ?? 0);

      // 2. Count unseen re-enquiry activities
      const { count: activityCount } = await supabase
        .from("activities")
        .select("id", { count: "exact", head: true })
        .like("subject", "Re-enquiry via%")
        .gt("created_at", lastSeen);

      setReEnquiryCount(activityCount ?? 0);

      // 3. Recent new enquiry leads for dropdown (last 5)
      const { data: recentLeads } = await supabase
        .from("leads")
        .select("id, first_name, last_name, tags, created_at")
        .eq("status", "new")
        .overlaps("tags", FORM_TAGS)
        .order("created_at", { ascending: false })
        .limit(5);

      // 4. Recent re-enquiry activities for dropdown (last 5)
      const { data: recentActivities } = await supabase
        .from("activities")
        .select(
          "id, subject, created_at, lead:leads!activities_lead_id_fkey(id, first_name, last_name)"
        )
        .like("subject", "Re-enquiry via%")
        .order("created_at", { ascending: false })
        .limit(5);

      const leadItems: EnquiryNotificationItem[] = (recentLeads ?? []).map((l) => {
        const matchingTag = (l.tags as string[]).find((t) => FORM_TAGS.includes(t)) ?? "";
        return {
          type: "lead",
          leadId: l.id,
          name: `${l.first_name} ${l.last_name}`,
          source: SOURCE_LABEL[matchingTag] ?? matchingTag,
          time: l.created_at,
        };
      });

      const activityItems: EnquiryNotificationItem[] = (recentActivities ?? []).map((a) => {
        const lead = a.lead as unknown as { id: string; first_name: string; last_name: string } | null;
        // Extract source from subject: "Re-enquiry via Google Ads form" → "Google Ads"
        const sourceMatch = (a.subject as string).match(/Re-enquiry via (.+?) form/);
        return {
          type: "activity",
          leadId: lead?.id ?? "",
          name: lead ? `${lead.first_name} ${lead.last_name}` : "Unknown",
          source: sourceMatch?.[1] ?? "Form",
          time: a.created_at,
        };
      });

      // Merge and sort by time DESC, keep max 10
      const merged = [...leadItems, ...activityItems]
        .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
        .slice(0, 10);

      setRecentItems(merged);
    }

    loadInitialData();

    // 5. Real-time subscription for new enquiries
    const channel = supabase
      .channel("enquiry-alerts")
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "leads" },
        (payload) => {
          const lead = payload.new as {
            id: string; first_name: string; last_name: string;
            tags: string[]; status: string; created_at: string;
          };
          if (!lead.tags?.some((t) => FORM_TAGS.includes(t))) return;

          const matchingTag = lead.tags.find((t) => FORM_TAGS.includes(t)) ?? "";
          const sourceLabel = SOURCE_LABEL[matchingTag] ?? "";
          const name = `${lead.first_name} ${lead.last_name}`;

          setNewLeadCount((c) => c + 1);
          setRecentItems((prev) => [
            { type: "lead", leadId: lead.id, name, source: sourceLabel, time: lead.created_at },
            ...prev,
          ].slice(0, 10));

          toast.success(`New enquiry — ${name} via ${sourceLabel}`, {
            duration: 6000,
            action: {
              label: "View Lead",
              onClick: () => router.push(`/leads/${lead.id}`),
            },
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "activities" },
        async (payload) => {
          const act = payload.new as {
            id: string; lead_id: string; subject: string; created_at: string;
          };
          if (!act.subject?.startsWith("Re-enquiry via")) return;

          // Fetch lead name
          const supabaseCl = createClient();
          const { data: lead } = await supabaseCl
            .from("leads")
            .select("id, first_name, last_name")
            .eq("id", act.lead_id)
            .single();

          const name = lead ? `${lead.first_name} ${lead.last_name}` : "Existing lead";
          const sourceMatch = act.subject.match(/Re-enquiry via (.+?) form/);
          const sourceLabel = sourceMatch?.[1] ?? "Form";

          setReEnquiryCount((c) => c + 1);
          setRecentItems((prev) => [
            {
              type: "activity",
              leadId: act.lead_id,
              name,
              source: sourceLabel,
              time: act.created_at,
            },
            ...prev,
          ].slice(0, 10));

          toast(`Re-enquiry — ${name} is enquiring again`, {
            duration: 6000,
            action: {
              label: "View Lead",
              onClick: () => router.push(`/leads/${act.lead_id}`),
            },
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [router]);

  return { totalCount, newLeadCount, reEnquiryCount, recentItems, markReEnquiriesSeen };
}

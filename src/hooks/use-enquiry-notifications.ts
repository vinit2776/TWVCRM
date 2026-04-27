"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

const FORM_TAGS = ["google-ads-form", "meta-ads-form", "walkin-form"];
const LS_KEY = "twv_last_seen_reenquiry";
const LS_KEY_WA = "twv_last_seen_wa_inbound";
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

export interface WhatsAppInboundItem {
  id: string;
  fromNumber: string;
  messagePreview: string;
  time: string;
  leadId?: string;
}

export interface EnquiryAlert {
  alertId: string; // unique key for dismissal
  type: "lead" | "activity";
  leadId: string;
  name: string;
  source: string;
}

/** Two-tone chime using Web Audio API — no external file needed */
function playChime() {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();

    // First tone: 880 Hz
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.connect(g1);
    g1.connect(ctx.destination);
    osc1.type = "sine";
    osc1.frequency.value = 880;
    g1.gain.setValueAtTime(0.22, ctx.currentTime);
    g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    osc1.start(ctx.currentTime);
    osc1.stop(ctx.currentTime + 0.28);

    // Second tone: 1320 Hz after 150 ms
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.connect(g2);
    g2.connect(ctx.destination);
    osc2.type = "sine";
    osc2.frequency.value = 1320;
    g2.gain.setValueAtTime(0, ctx.currentTime + 0.15);
    g2.gain.setValueAtTime(0.18, ctx.currentTime + 0.15);
    g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc2.start(ctx.currentTime + 0.15);
    osc2.stop(ctx.currentTime + 0.5);
  } catch {
    /* ignore audio errors in restrictive environments */
  }
}

/**
 * Core hook — consumed via EnquiryNotificationsProvider to avoid
 * duplicate Supabase subscriptions across multiple consumers.
 */
export function useEnquiryNotificationsCore() {
  const router = useRouter();
  const [newLeadCount, setNewLeadCount]         = useState(0);
  const [reEnquiryCount, setReEnquiryCount]     = useState(0);
  const [recentItems, setRecentItems]           = useState<EnquiryNotificationItem[]>([]);
  const [alertQueue, setAlertQueue]             = useState<EnquiryAlert[]>([]);
  const [waInboundCount, setWaInboundCount]     = useState(0);
  const [waInboundItems, setWaInboundItems]     = useState<WhatsAppInboundItem[]>([]);

  // Tracks lead IDs with pending re-enquiries (used in real-time handlers to avoid stale closures)
  const reEnquiryLeadIdsRef = useRef<Set<string>>(new Set());

  const totalCount = newLeadCount + reEnquiryCount + waInboundCount;

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

  const dismissAlert = useCallback((alertId: string) => {
    setAlertQueue((prev) => prev.filter((a) => a.alertId !== alertId));
  }, []);

  const dismissAllAlerts = useCallback(() => {
    setAlertQueue([]);
  }, []);

  const dismissReEnquiryItem = useCallback((leadId: string) => {
    reEnquiryLeadIdsRef.current.delete(leadId);
    setRecentItems((prev) => prev.filter((i) => !(i.type === "activity" && i.leadId === leadId)));
    setReEnquiryCount((c) => Math.max(0, c - 1));
  }, []);

  const markWhatsAppSeen = useCallback(() => {
    try { localStorage.setItem(LS_KEY_WA, new Date().toISOString()); } catch { /* ignore */ }
    setWaInboundCount(0);
  }, []);

  useEffect(() => {
    const supabase = createClient();

    async function loadInitialData() {
      const lastSeen = getLastSeen();
      const lastSeenWa = (() => { try { return localStorage.getItem(LS_KEY_WA) || new Date(Date.now() - 24 * 3600 * 1000).toISOString(); } catch { return new Date(Date.now() - 24 * 3600 * 1000).toISOString(); } })();
      const [
        { count: leadCount },
        { data: recentLeads },
        { data: allReEnquiryActivities },
        { data: inboundMessages, count: inboundCount },
      ] = await Promise.all([
        // 1. Count unactioned new leads from public forms
        supabase
          .from("leads")
          .select("id", { count: "exact", head: true })
          .eq("status", "new")
          .overlaps("tags", FORM_TAGS),
        // 2. Recent new enquiry leads for dropdown (last 5)
        supabase
          .from("leads")
          .select("id, first_name, last_name, tags, created_at")
          .eq("status", "new")
          .overlaps("tags", FORM_TAGS)
          .order("created_at", { ascending: false })
          .limit(5),
        // 3. Re-enquiry activities with lead status — filter in JS to only show
        //    leads still in early pipeline stages (new / contacted)
        supabase
          .from("activities")
          .select("id, subject, created_at, lead:leads!activities_lead_id_fkey(id, first_name, last_name, status)")
          .like("subject", "Re-enquiry via%")
          .gt("created_at", lastSeen)
          .order("created_at", { ascending: false })
          .limit(100),
        // 4. Unread inbound WhatsApp messages since last seen
        supabase
          .from("whatsapp_messages")
          .select("id, from_number, message_body, created_at, entity_id, entity_type", { count: "exact" })
          .eq("direction", "inbound")
          .eq("channel", "whatsapp")
          .gt("created_at", lastSeenWa)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      // Only show re-enquiries for leads still at "new" status
      const EARLY_STATUSES = ["new"];
      const activeReEnquiries = (allReEnquiryActivities ?? []).filter((a) => {
        const lead = a.lead as unknown as { status: string } | null;
        return !lead || EARLY_STATUSES.includes(lead.status);
      });

      // Keep ref in sync so real-time UPDATE handler can check without stale closure
      reEnquiryLeadIdsRef.current = new Set(
        activeReEnquiries
          .map((a) => (a.lead as unknown as { id: string } | null)?.id)
          .filter((id): id is string => Boolean(id))
      );

      setNewLeadCount(leadCount ?? 0);
      setReEnquiryCount(activeReEnquiries.length);
      setWaInboundCount(inboundCount ?? 0);
      setWaInboundItems(
        (inboundMessages ?? []).map((m) => ({
          id: m.id,
          fromNumber: m.from_number ?? "Unknown",
          messagePreview: (m.message_body ?? "").substring(0, 80),
          time: m.created_at,
          leadId: m.entity_type === "lead" && m.entity_id ? m.entity_id : undefined,
        }))
      );

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

      const activityItems: EnquiryNotificationItem[] = activeReEnquiries.slice(0, 5).map((a) => {
        const lead = a.lead as unknown as { id: string; first_name: string; last_name: string } | null;
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

    loadInitialData().catch((err) => {
      console.error("[useEnquiryNotifications] loadInitialData failed:", err);
    });

    // Re-validate when the user returns to this tab (self-healing for stale items)
    let lastLoadTime = Date.now();
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && Date.now() - lastLoadTime > 120_000) {
        lastLoadTime = Date.now();
        loadInitialData().catch((err) =>
          console.error("[useEnquiryNotifications] revalidation failed:", err)
        );
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // 5. Real-time subscription for new enquiries + WhatsApp inbound
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

          // Alert banner + audio chime
          const alertId = `lead-${lead.id}-${Date.now()}`;
          // Batch all state updates into a single render pass
          unstable_batchedUpdates(() => {
            setNewLeadCount((c) => c + 1);
            setRecentItems((prev) => [
              { type: "lead" as const, leadId: lead.id, name, source: sourceLabel, time: lead.created_at },
              ...prev,
            ].slice(0, 10));
            setAlertQueue((prev) => [
              ...prev,
              { alertId, type: "lead", leadId: lead.id, name, source: sourceLabel },
            ]);
          });
          playChime();

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
        { event: "UPDATE", schema: "public", table: "leads" },
        (payload) => {
          const lead = payload.new as { id: string; status: string; tags: string[] };
          const earlyStatuses = new Set(["new"]);

          // Remove from new-lead alerts when a form lead's status changes away from "new"
          if (lead.status !== "new" && lead.tags?.some((t) => FORM_TAGS.includes(t))) {
            setRecentItems((prev) => prev.filter((i) => !(i.type === "lead" && i.leadId === lead.id)));
            setNewLeadCount((c) => Math.max(0, c - 1));
          }

          // Remove from re-enquiry alerts when lead is actioned (status leaves "new")
          if (!earlyStatuses.has(lead.status) && reEnquiryLeadIdsRef.current.has(lead.id)) {
            reEnquiryLeadIdsRef.current.delete(lead.id);
            setRecentItems((prev) => prev.filter((i) => !(i.type === "activity" && i.leadId === lead.id)));
            setReEnquiryCount((c) => Math.max(0, c - 1));
          }
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

          // Fetch lead name — reuse the existing supabase client (no new client needed)
          const { data: lead } = await supabase
            .from("leads")
            .select("id, first_name, last_name")
            .eq("id", act.lead_id)
            .single();

          const name = lead ? `${lead.first_name} ${lead.last_name}` : "Existing lead";
          const sourceMatch = act.subject.match(/Re-enquiry via (.+?) form/);
          const sourceLabel = sourceMatch?.[1] ?? "Form";

          // Track this lead as having a pending re-enquiry
          reEnquiryLeadIdsRef.current = new Set([...reEnquiryLeadIdsRef.current, act.lead_id]);

          // Alert banner + audio chime
          const alertId = `activity-${act.id}-${Date.now()}`;
          // Batch all state updates into a single render pass
          unstable_batchedUpdates(() => {
            setReEnquiryCount((c) => c + 1);
            setRecentItems((prev) => [
              {
                type: "activity" as const,
                leadId: act.lead_id,
                name,
                source: sourceLabel,
                time: act.created_at,
              },
              ...prev,
            ].slice(0, 10));
            setAlertQueue((prev) => [
              ...prev,
              { alertId, type: "activity", leadId: act.lead_id, name, source: sourceLabel },
            ]);
          });
          playChime();

          toast(`Re-enquiry — ${name} is enquiring again`, {
            duration: 6000,
            action: {
              label: "View Lead",
              onClick: () => router.push(`/leads/${act.lead_id}`),
            },
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "whatsapp_messages", filter: "direction=eq.inbound" },
        (payload) => {
          const msg = payload.new as {
            id: string; from_number: string; message_body: string;
            created_at: string; entity_type: string | null; entity_id: string | null;
          };

          const item: WhatsAppInboundItem = {
            id: msg.id,
            fromNumber: msg.from_number ?? "Unknown",
            messagePreview: (msg.message_body ?? "").substring(0, 80),
            time: msg.created_at,
            leadId: msg.entity_type === "lead" && msg.entity_id ? msg.entity_id : undefined,
          };

          unstable_batchedUpdates(() => {
            setWaInboundCount((c) => c + 1);
            setWaInboundItems((prev) => [item, ...prev].slice(0, 10));
          });

          playChime();

          toast(`WhatsApp reply from ${msg.from_number}`, {
            description: (msg.message_body ?? "").substring(0, 60) || undefined,
            duration: 8000,
            action: item.leadId
              ? { label: "View Lead", onClick: () => router.push(`/leads/${item.leadId}`) }
              : undefined,
          });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [router]);

  return {
    totalCount,
    newLeadCount,
    reEnquiryCount,
    recentItems,
    markReEnquiriesSeen,
    alertQueue,
    dismissAlert,
    dismissAllAlerts,
    dismissReEnquiryItem,
    waInboundCount,
    waInboundItems,
    markWhatsAppSeen,
  };
}

"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { unstable_batchedUpdates } from "react-dom";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";

const FORM_TAGS = ["google-ads-form", "meta-ads-form", "walkin-form"];
const LS_KEY_WA = "twv_last_seen_wa_inbound";
const SOURCE_LABEL: Record<string, string> = {
  "google-ads-form":  "Google Ads",
  "meta-ads-form":    "Meta Ads",
  "walkin-form":      "Walk-in",
};

const RESOLVED_GRACE_MS = 10 * 60 * 1000;

export type ResolutionOutcome = "converted" | "not_interested" | "no_response";

export interface EnquiryItem {
  leadId: string;
  name: string;
  mobile: string | null;
  source: string;
  sourceTag: string;
  attentionResetAt: string;
  createdAt: string;
  isReEnquiry: boolean;
  claimedBy: string | null;
  claimedAt: string | null;
  claimerName: string | null;
  resolverName: string | null;
  resolvedAt: string | null;
  resolutionOutcome: ResolutionOutcome | null;
}

export interface WhatsAppInboundItem {
  id: string;
  fromNumber: string;
  messagePreview: string;
  time: string;
  leadId?: string;
}

export interface EnquiryAlert {
  alertId: string;
  type: "lead" | "activity";
  leadId: string;
  name: string;
  source: string;
}

function playChime() {
  if (typeof window === "undefined") return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc1 = ctx.createOscillator();
    const g1 = ctx.createGain();
    osc1.connect(g1); g1.connect(ctx.destination);
    osc1.type = "sine"; osc1.frequency.value = 880;
    g1.gain.setValueAtTime(0.22, ctx.currentTime);
    g1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.28);
    osc1.start(ctx.currentTime); osc1.stop(ctx.currentTime + 0.28);
    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.connect(g2); g2.connect(ctx.destination);
    osc2.type = "sine"; osc2.frequency.value = 1320;
    g2.gain.setValueAtTime(0, ctx.currentTime + 0.15);
    g2.gain.setValueAtTime(0.18, ctx.currentTime + 0.15);
    g2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc2.start(ctx.currentTime + 0.15); osc2.stop(ctx.currentTime + 0.5);
  } catch { /* ignore */ }
}

type RawLeadRow = {
  id: string; first_name: string; last_name: string; mobile: string | null;
  tags: string[] | null; created_at: string; attention_reset_at: string | null;
  claimed_by: string | null; claimed_at: string | null;
  resolved_at: string | null; resolution_outcome: ResolutionOutcome | null;
  claimer?: { id: string; full_name: string } | null;
};

function toItem(row: RawLeadRow): EnquiryItem | null {
  const matchingTag = (row.tags ?? []).find((t) => FORM_TAGS.includes(t));
  if (!matchingTag) return null;
  const attentionResetAt = row.attention_reset_at ?? row.created_at;
  return {
    leadId: row.id,
    name: `${row.first_name ?? ""} ${row.last_name ?? ""}`.trim() || "Unknown",
    mobile: row.mobile,
    source: SOURCE_LABEL[matchingTag] ?? matchingTag,
    sourceTag: matchingTag,
    attentionResetAt,
    createdAt: row.created_at,
    isReEnquiry: new Date(attentionResetAt).getTime() - new Date(row.created_at).getTime() > 1000,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    claimerName: row.claimer?.full_name ?? null,
    resolverName: null,
    resolvedAt: row.resolved_at,
    resolutionOutcome: row.resolution_outcome,
  };
}

const SELECT_COLS =
  "id, first_name, last_name, mobile, tags, created_at, attention_reset_at, " +
  "claimed_by, claimed_at, resolved_at, resolution_outcome, " +
  "claimer:users!leads_claimed_by_fkey(id, full_name)";

export function useEnquiryNotificationsCore() {
  const router = useRouter();
  const [rawItems, setItems]                    = useState<EnquiryItem[]>([]);
  const [alertQueue, setAlertQueue]             = useState<EnquiryAlert[]>([]);
  const [waInboundCount, setWaInboundCount]     = useState(0);
  const [waInboundItems, setWaInboundItems]     = useState<WhatsAppInboundItem[]>([]);
  // Bumped after every successful claim/release/resolve so views that keep their own copy
  // of the enquiry record (the Leads page tracker) know to refetch.
  const [actionVersion, setActionVersion]       = useState(0);

  const graceTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const items = [...rawItems].sort((a, b) => {
    const aResolved = a.resolvedAt ? 1 : 0;
    const bResolved = b.resolvedAt ? 1 : 0;
    if (aResolved !== bResolved) return aResolved - bResolved;
    return new Date(b.attentionResetAt).getTime() - new Date(a.attentionResetAt).getTime();
  });

  const activeCount   = items.filter((i) => !i.resolvedAt).length;
  const unclaimedCount = items.filter((i) => !i.resolvedAt && !i.claimedBy).length;

  const scheduleGraceRemoval = useCallback((leadId: string) => {
    const existing = graceTimersRef.current.get(leadId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      setItems((prev) => prev.filter((i) => i.leadId !== leadId));
      graceTimersRef.current.delete(leadId);
    }, RESOLVED_GRACE_MS);
    graceTimersRef.current.set(leadId, t);
  }, []);

  const cancelGraceRemoval = useCallback((leadId: string) => {
    const t = graceTimersRef.current.get(leadId);
    if (t) { clearTimeout(t); graceTimersRef.current.delete(leadId); }
  }, []);

  const dismissAlert = useCallback((alertId: string) => {
    setAlertQueue((prev) => prev.filter((a) => a.alertId !== alertId));
  }, []);

  const dismissAllAlerts = useCallback(() => { setAlertQueue([]); }, []);

  const markWhatsAppSeen = useCallback(() => {
    try { localStorage.setItem(LS_KEY_WA, new Date().toISOString()); } catch { /* ignore */ }
    setWaInboundCount(0);
  }, []);

  const claim = useCallback(async (leadId: string) => {
    const res = await fetch(`/api/leads/${leadId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimed: true }),
    });
    if (!res.ok) { toast.error("Could not claim enquiry"); return; }
    setItems((prev) =>
      prev.map((i) =>
        i.leadId === leadId
          ? { ...i, claimedAt: new Date().toISOString(), claimedBy: "self", claimerName: "You" }
          : i
      )
    );
    setActionVersion((v) => v + 1);
    toast.success("Marked as on-it");
  }, []);

  const unclaim = useCallback(async (leadId: string) => {
    const res = await fetch(`/api/leads/${leadId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ claimed: false }),
    });
    if (!res.ok) { toast.error("Could not release claim"); return; }
    setItems((prev) =>
      prev.map((i) =>
        i.leadId === leadId ? { ...i, claimedAt: null, claimedBy: null, claimerName: null } : i
      )
    );
    setActionVersion((v) => v + 1);
  }, []);

  const resolve = useCallback(
    async (leadId: string, outcome: ResolutionOutcome) => {
      const res = await fetch(`/api/leads/${leadId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      if (!res.ok) { toast.error("Could not resolve enquiry"); return; }
      setItems((prev) =>
        prev.map((i) =>
          i.leadId === leadId
            ? { ...i, resolvedAt: new Date().toISOString(), resolutionOutcome: outcome }
            : i
        )
      );
      scheduleGraceRemoval(leadId);
      setActionVersion((v) => v + 1);
      toast.success("Marked resolved");
    },
    [scheduleGraceRemoval]
  );

  useEffect(() => {
    const supabase = createClient();

    async function loadInitialData() {
      const lastSeenWa = (() => {
        try {
          return localStorage.getItem(LS_KEY_WA) || new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        } catch {
          return new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        }
      })();

      const [{ data: leadRows }, { data: inboundMessages, count: inboundCount }] = await Promise.all([
        supabase
          .from("leads")
          .select(SELECT_COLS)
          .is("resolved_at", null)
          .overlaps("tags", FORM_TAGS)
          .order("attention_reset_at", { ascending: false, nullsFirst: false })
          .limit(50),
        supabase
          .from("whatsapp_messages")
          .select("id, from_number, message_body, created_at, entity_id, entity_type", { count: "exact" })
          .eq("direction", "inbound")
          .eq("channel", "whatsapp")
          .gt("created_at", lastSeenWa)
          .order("created_at", { ascending: false })
          .limit(10),
      ]);

      const mapped = (leadRows ?? [])
        .map((r) => toItem(r as unknown as RawLeadRow))
        .filter((i): i is EnquiryItem => i !== null);

      setItems(mapped);
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
    }

    loadInitialData().catch((err) => {
      console.error("[useEnquiryNotifications] loadInitialData failed:", err);
    });

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

    async function fetchOne(leadId: string): Promise<EnquiryItem | null> {
      const { data } = await supabase.from("leads").select(SELECT_COLS).eq("id", leadId).single();
      if (!data) return null;
      return toItem(data as unknown as RawLeadRow);
    }

    const channel = supabase
      .channel("enquiry-alerts")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "leads" }, async (payload) => {
        const lead = payload.new as { id: string; tags: string[] };
        if (!lead.tags?.some((t) => FORM_TAGS.includes(t))) return;
        const item = await fetchOne(lead.id);
        if (!item) return;
        const alertId = `lead-${lead.id}-${Date.now()}`;
        unstable_batchedUpdates(() => {
          setItems((prev) =>
            prev.some((i) => i.leadId === item.leadId) ? prev : [item, ...prev].slice(0, 50)
          );
          setAlertQueue((prev) => [
            ...prev,
            { alertId, type: "lead", leadId: item.leadId, name: item.name, source: item.source },
          ]);
        });
        playChime();
        toast.success(`New enquiry — ${item.name} via ${item.source}`, {
          duration: 6000,
          action: { label: "View Lead", onClick: () => router.push(`/leads/${item.leadId}`) },
        });
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "leads" }, async (payload) => {
        const lead = payload.new as { id: string; tags: string[] };
        if (!lead.tags?.some((t) => FORM_TAGS.includes(t))) return;
        const item = await fetchOne(lead.id);
        if (!item) { setItems((prev) => prev.filter((i) => i.leadId !== lead.id)); return; }
        setItems((prev) => {
          const existing = prev.find((i) => i.leadId === item.leadId);
          if (existing?.resolvedAt && !item.resolvedAt) cancelGraceRemoval(item.leadId);
          if (!existing?.resolvedAt && item.resolvedAt) scheduleGraceRemoval(item.leadId);
          if (existing) return prev.map((i) => (i.leadId === item.leadId ? item : i));
          return [item, ...prev].slice(0, 50);
        });
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "activities" }, async (payload) => {
        const act = payload.new as { id: string; lead_id: string; subject: string };
        if (!act.subject?.startsWith("Re-enquiry via")) return;
        const item = await fetchOne(act.lead_id);
        const name = item?.name ?? "Existing lead";
        const sourceMatch = act.subject.match(/Re-enquiry via (.+?) form/);
        const sourceLabel = sourceMatch?.[1] ?? "Form";
        const alertId = `activity-${act.id}-${Date.now()}`;
        setAlertQueue((prev) => [
          ...prev,
          { alertId, type: "activity", leadId: act.lead_id, name, source: sourceLabel },
        ]);
        playChime();
        toast(`Re-enquiry — ${name} is enquiring again`, {
          duration: 6000,
          action: { label: "View Lead", onClick: () => router.push(`/leads/${act.lead_id}`) },
        });
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "whatsapp_messages", filter: "direction=eq.inbound" }, (payload) => {
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
      })
      .subscribe();

    const timers = graceTimersRef.current;
    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, [router, scheduleGraceRemoval, cancelGraceRemoval]);

  return {
    items, activeCount, unclaimedCount,
    totalCount: activeCount + waInboundCount,
    claim, unclaim, resolve, actionVersion,
    alertQueue, dismissAlert, dismissAllAlerts,
    waInboundCount, waInboundItems, markWhatsAppSeen,
  };
}

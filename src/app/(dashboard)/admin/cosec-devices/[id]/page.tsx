"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "sonner";
import {
  Wifi, WifiOff, Loader2, ArrowLeft, ShieldCheck, ShieldOff,
  Fingerprint, CreditCard, Clock, DoorOpen, RefreshCw,
  LogIn, LogOut, Ban, BarChart3, Users, AlertTriangle, TrendingUp,
  MonitorSmartphone, CheckCircle2, XCircle,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UnlinkedRef {
  cosec_ref_id: number;
  entry_count: number;
  last_seen: string;
  directions: { IN: number; OUT: number; DENIED: number };
}

interface ContractOption {
  id: string;
  contract_number: string;
  entity_name: string;
  valid_until: string | null;
  status: string;
}

interface Device {
  id: string; label: string; device_ip: string; device_port: number;
  is_enabled: boolean; device_category: "entry_point" | "business_centre";
  supports_biometric: boolean;
  last_ping_at: string | null; last_ping_success: boolean | null;
  last_polled_at: string | null; last_seq_number: number;
  location: { name: string };
}

interface AccessUser {
  id: string; cosec_user_id: string; cosec_ref_id: number;
  user_type: "contract" | "employee" | "booking" | "member";
  entity_id: string; enrollment_status: string;
  nfc_card_number: string | null; access_pin: string | null;
  valid_until: string | null; provisioned_at: string | null;
  biometric_enrolled_at: string | null; card_enrolled_at: string | null;
  blocked_at: string | null; deleted_at: string | null;
  entity_name?: string;
  contract_number?: string;  // for contracts: their own; for members: parent contract
  phone?: string;
}

interface AccessLog {
  id: string; cosec_ref_id: number; user_type: string;
  direction: "IN" | "OUT" | "DENIED"; raw_event_id: number;
  event_time: string; device_seq_number: number;
  entity_name?: string; denial_reason?: string;
}

interface PresenceRow {
  entity_id: string; entity_name: string; user_type: string;
  is_inside: boolean; last_entry_at: string | null; last_exit_at: string | null;
}

interface LiveDeviceUser {
  user_id: string;
  ref_user_id: number;
  name: string;
  is_active: boolean;
  finger_count: number;
  card_number: string | null;
  is_linked: boolean;
  entity_name: string | null;
  entity_type: string | null;
  enrollment_status: string | null;
  db_id: string | null;
}

interface HeatmapRow { day: number; hour: number; count: number; }
interface AttendanceRow {
  entity_id: string; entity_name: string; user_type: string;
  unique_days: number; total_entries: number; last_seen: string;
}
interface DenialSummary {
  entity_id: string | null; entity_name: string; count: number;
  reasons: Record<string, number>; last_denied_at: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:            { label: "Pending",            variant: "secondary" },
  provisioned:        { label: "Provisioned",        variant: "outline" },
  biometric_enrolled: { label: "Biometric Enrolled", variant: "default" },
  card_enrolled:      { label: "Card Enrolled",      variant: "default" },
  fully_enrolled:     { label: "Fully Enrolled",     variant: "default" },
  blocked:            { label: "Blocked",            variant: "destructive" },
  deleted:            { label: "Deleted",            variant: "secondary" },
};

const TYPE_LABELS: Record<string, string> = {
  contract: "Contract", employee: "Employee", booking: "Walk-in Booking", member: "Member",
};

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const HEATMAP_COLORS = ["#f0f9ff", "#bae6fd", "#38bdf8", "#0284c7", "#075985"];

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CosecDeviceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const supabase = createClient();

  const [device, setDevice]               = useState<Device | null>(null);
  const [users, setUsers]                 = useState<AccessUser[]>([]);
  const [logs, setLogs]                   = useState<AccessLog[]>([]);
  const [loading, setLoading]             = useState(true);
  const [pinging, setPinging]             = useState(false);
  const [pingResult, setPingResult]       = useState<{ ok: boolean; deviceName?: string; latencyMs?: number; error?: string } | null>(null);
  const [openingDoor, setOpeningDoor]     = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  // Analytics state
  const [analyticsLoading, setAnalyticsLoading]   = useState(false);
  const [presence, setPresence]                     = useState<PresenceRow[]>([]);
  const [heatmap, setHeatmap]                       = useState<HeatmapRow[]>([]);
  const [attendance, setAttendance]                 = useState<AttendanceRow[]>([]);
  const [denialSummary, setDenialSummary]           = useState<DenialSummary[]>([]);
  const [analyticsDays, setAnalyticsDays]           = useState(30);

  // Active tab
  const [activeTab, setActiveTab]                   = useState("users");

  // Card assign state
  const [cardAssigning, setCardAssigning]           = useState<string | null>(null); // access_user_id being assigned

  // Live device tab
  const [liveUsers, setLiveUsers]                   = useState<LiveDeviceUser[]>([]);
  const [liveLoading, setLiveLoading]               = useState(false);
  const [liveError, setLiveError]                   = useState<string | null>(null);
  const [liveFilter, setLiveFilter]                 = useState<"all" | "unlinked">("all");

  // Unlinked tab state
  const [unlinked, setUnlinked]               = useState<UnlinkedRef[]>([]);
  const [unlinkedLoading, setUnlinkedLoading] = useState(false);
  const [linkDialog, setLinkDialog]           = useState<{ open: boolean; ref: UnlinkedRef | null }>({ open: false, ref: null });
  const [contracts, setContracts]             = useState<ContractOption[]>([]);
  const [contractSearch, setContractSearch]   = useState("");
  const [selectedContract, setSelectedContract] = useState<string>("");
  const [linking, setLinking]                 = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    // Logs: only last 12 months — old events (2023/2024) are noise for daily ops
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);

    const [{ data: dev }, { data: accessUsers }, { data: accessLogs }] = await Promise.all([
      supabase.from("cosec_devices").select("*, location:locations(name)").eq("id", id).single(),
      supabase.from("cosec_access_users").select("*").eq("device_id", id)
        .neq("enrollment_status", "deleted").order("provisioned_at", { ascending: false }),
      supabase.from("access_logs").select("*").eq("device_id", id)
        .gte("event_time", twelveMonthsAgo.toISOString())
        .order("event_time", { ascending: false }).limit(500),
    ]);

    if (!dev) { router.push("/admin/cosec-devices"); return; }
    setDevice(dev as Device);

    if (accessUsers) {
      const enriched = await enrichUsers(accessUsers as AccessUser[]);
      setUsers(enriched);
      if (accessLogs) {
        const refMap: Record<number, string> = {};
        enriched.forEach(u => { refMap[u.cosec_ref_id] = u.entity_name || u.cosec_user_id; });
        setLogs((accessLogs as AccessLog[]).map(l => ({
          ...l,
          entity_name: l.entity_name || refMap[l.cosec_ref_id] || `Ref #${l.cosec_ref_id}`,
        })));
      }
    }
    setLoading(false);
  }, [id, router]); // eslint-disable-line react-hooks/exhaustive-deps

  async function enrichUsers(rawUsers: AccessUser[]): Promise<AccessUser[]> {
    const byType: Record<string, string[]> = { contract: [], employee: [], booking: [], member: [] };
    for (const u of rawUsers) {
      if (u.user_type in byType) byType[u.user_type].push(u.entity_id);
    }
    const [contracts, employees, bookings, members] = await Promise.all([
      byType.contract.length
        ? supabase.from("contracts")
            .select("id, contract_number, lead:leads!contracts_lead_id_fkey(company, first_name, last_name, phone)")
            .in("id", byType.contract)
        : { data: [] },
      byType.employee.length
        ? supabase.from("employees").select("id, full_name, phone").in("id", byType.employee)
        : { data: [] },
      byType.booking.length
        ? supabase.from("bookings").select("id, booking_number, guest_name, guest_phone").in("id", byType.booking)
        : { data: [] },
      byType.member.length
        // fetch parent contract_number via join so we can display it
        ? supabase.from("contract_members")
            .select("id, name, phone, contract:contracts(contract_number)")
            .in("id", byType.member)
        : { data: [] },
    ]);

    const nameMap: Record<string, string> = {};
    const contractNumberMap: Record<string, string> = {};
    const phoneMap: Record<string, string> = {};

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (contracts.data || []).forEach((c: any) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lead = Array.isArray(c.lead) ? c.lead[0] : c.lead as any;
      nameMap[c.id] = lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || c.contract_number;
      contractNumberMap[c.id] = c.contract_number;
      if (lead?.phone) phoneMap[c.id] = lead.phone;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (employees.data || []).forEach((e: any) => {
      nameMap[e.id] = e.full_name;
      if (e.phone) phoneMap[e.id] = e.phone;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (bookings.data || []).forEach((b: any) => {
      nameMap[b.id] = b.guest_name || `Booking #${b.booking_number}`;
      if (b.guest_phone) phoneMap[b.id] = b.guest_phone;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (members.data || []).forEach((m: any) => {
      nameMap[m.id] = m.name;
      if (m.phone) phoneMap[m.id] = m.phone;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const contract = Array.isArray(m.contract) ? m.contract[0] : m.contract as any;
      if (contract?.contract_number) contractNumberMap[m.id] = contract.contract_number;
    });

    return rawUsers.map(u => ({
      ...u,
      entity_name: nameMap[u.entity_id] || u.cosec_user_id,
      contract_number: contractNumberMap[u.entity_id] ?? undefined,
      phone: phoneMap[u.entity_id] ?? undefined,
    }));
  }

  const loadAnalytics = useCallback(async () => {
    setAnalyticsLoading(true);
    const base = `/api/cosec/analytics?device_id=${id}&days=${analyticsDays}`;
    const [presRes, heatRes, attRes, denRes] = await Promise.all([
      fetch(`${base}&type=presence`),
      fetch(`${base}&type=heatmap`),
      fetch(`${base}&type=attendance`),
      fetch(`${base}&type=denials`),
    ]);
    const [presJson, heatJson, attJson, denJson] = await Promise.all([
      presRes.json(), heatRes.json(), attRes.json(), denRes.json(),
    ]);
    setPresence(presJson.data ?? []);
    setHeatmap(heatJson.data ?? []);
    setAttendance(attJson.data ?? []);
    setDenialSummary(denJson.summary ?? []);
    setAnalyticsLoading(false);
  }, [id, analyticsDays]);

  const loadUnlinked = useCallback(async () => {
    setUnlinkedLoading(true);
    // Fetch all ref IDs that have logs for this device in the last 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const { data: logRefs } = await supabase
      .from("access_logs")
      .select("cosec_ref_id, direction, event_time")
      .eq("device_id", id)
      .gte("event_time", twelveMonthsAgo.toISOString())
      .not("cosec_ref_id", "is", null);

    // Fetch all linked ref IDs for this device
    const { data: linked } = await supabase
      .from("cosec_access_users")
      .select("cosec_ref_id")
      .eq("device_id", id);

    const linkedSet = new Set((linked ?? []).map(u => u.cosec_ref_id));

    // Group unlinked
    const refMap = new Map<number, UnlinkedRef>();
    for (const row of logRefs ?? []) {
      if (row.cosec_ref_id === null || linkedSet.has(row.cosec_ref_id)) continue;
      const ref = row.cosec_ref_id as number;
      if (!refMap.has(ref)) {
        refMap.set(ref, { cosec_ref_id: ref, entry_count: 0, last_seen: row.event_time, directions: { IN: 0, OUT: 0, DENIED: 0 } });
      }
      const entry = refMap.get(ref)!;
      entry.entry_count++;
      if (row.event_time > entry.last_seen) entry.last_seen = row.event_time;
      if (row.direction === "IN") entry.directions.IN++;
      else if (row.direction === "OUT") entry.directions.OUT++;
      else entry.directions.DENIED++;
    }

    setUnlinked([...refMap.values()].sort((a, b) => b.entry_count - a.entry_count));
    setUnlinkedLoading(false);
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadContracts = useCallback(async () => {
    const { data } = await supabase
      .from("contracts")
      .select("id, contract_number, valid_until, status, lead:leads!contracts_lead_id_fkey(company, first_name, last_name)")
      .in("status", ["active", "pending"])
      .order("contract_number");
    setContracts((data ?? []).map((c: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      const lead = Array.isArray(c.lead) ? c.lead[0] : c.lead as any; // eslint-disable-line @typescript-eslint/no-explicit-any
      return {
        id: c.id,
        contract_number: c.contract_number,
        entity_name: lead?.company || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim() || c.contract_number,
        valid_until: c.valid_until,
        status: c.status,
      };
    }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLiveUsers = useCallback(async () => {
    setLiveLoading(true);
    setLiveError(null);
    try {
      const res = await fetch(`/api/cosec/device-live-users?device_id=${id}`);
      const json = await res.json();
      if (!res.ok) {
        setLiveError(json.error ?? "Failed to fetch live users from device");
      } else {
        setLiveUsers(json.data ?? []);
      }
    } catch {
      setLiveError("Network error — could not reach device");
    } finally {
      setLiveLoading(false);
    }
  }, [id]);

  async function handleLink() {
    if (!linkDialog.ref || !selectedContract) return;
    setLinking(true);
    try {
      const res = await fetch("/api/cosec/link-contract-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          device_id: id,
          cosec_ref_id: linkDialog.ref.cosec_ref_id,
          contract_id: selectedContract,
        }),
      });
      const result = await res.json();
      if (result.ok) {
        toast.success(`Linked to ${result.entity_name}`);
        setLinkDialog({ open: false, ref: null });
        setSelectedContract("");
        await Promise.all([load(), loadUnlinked()]);
      } else {
        toast.error(result.error || "Failed to link");
      }
    } finally {
      setLinking(false);
    }
  }

  useEffect(() => {
    load();
    // Auto-load live device users in background so the Live Device tab is ready
    // and we can show a banner on the Enrolled tab for unlinked legacy users.
    loadLiveUsers();
  }, [load, loadLiveUsers]);

  // ── Action handlers ────────────────────────────────────────────────────────

  async function handlePing() {
    setPinging(true); setPingResult(null);
    try {
      const res = await fetch("/api/cosec/test-connection", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: id }) });
      const result = await res.json();
      setPingResult(result);
      if (result.ok) toast.success(`Connected — ${result.deviceName} (${result.latencyMs}ms)`);
      else toast.error(`Unreachable: ${result.error}`);
      await load();
    } finally { setPinging(false); }
  }

  async function handleSetDeviceCategory(category: "entry_point" | "business_centre") {
    if (!device || device.device_category === category) return;
    const { error } = await supabase.from("cosec_devices").update({ device_category: category }).eq("id", id);
    if (error) { toast.error("Failed to update device category"); return; }
    setDevice(d => d ? { ...d, device_category: category } : d);
    toast.success(category === "entry_point"
      ? "Device set to Entry Point — members will enroll here permanently"
      : "Device set to Business Centre — temporary booking-based PIN access only");
  }

  async function handleSetBiometricCapability(supports: boolean) {
    if (!device || device.supports_biometric === supports) return;
    const { error } = await supabase.from("cosec_devices").update({ supports_biometric: supports }).eq("id", id);
    if (error) { toast.error("Failed to update reader capability"); return; }
    setDevice(d => d ? { ...d, supports_biometric: supports } : d);
    toast.success(supports
      ? "Reader capability set to Biometric + NFC"
      : "Reader capability set to NFC Card Only — biometric step will be skipped in onboarding");
  }

  async function handleOpenDoor() {
    setOpeningDoor(true);
    try {
      const res = await fetch("/api/cosec/open-door", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_id: id }) });
      const result = await res.json();
      if (result.ok) toast.success("Door opened"); else toast.error(result.error || "Failed to open door");
    } finally { setOpeningDoor(false); }
  }

  async function handleBlock(user: AccessUser) {
    setActionLoading(a => ({ ...a, [user.id]: true }));
    try {
      const res = await fetch("/api/cosec/block-user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_user_id: user.id }) });
      const result = await res.json();
      if (result.ok) { toast.success("Access blocked"); await load(); } else toast.error(result.error || "Failed");
    } finally { setActionLoading(a => ({ ...a, [user.id]: false })); }
  }

  async function handleRestore(user: AccessUser) {
    setActionLoading(a => ({ ...a, [user.id]: true }));
    try {
      const res = await fetch("/api/cosec/restore-user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_user_id: user.id }) });
      const result = await res.json();
      if (result.ok) { toast.success("Access restored"); await load(); } else toast.error(result.error || "Failed");
    } finally { setActionLoading(a => ({ ...a, [user.id]: false })); }
  }

  async function handleReprovision(user: AccessUser) {
    setActionLoading(a => ({ ...a, [`reprov_${user.id}`]: true }));
    try {
      const res = await fetch("/api/cosec/provision-user", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_user_id: user.id }) });
      const result = await res.json();
      if (result.ok) { toast.success("Re-provisioned on device"); await load(); } else toast.error(result.error || "Failed");
    } finally { setActionLoading(a => ({ ...a, [`reprov_${user.id}`]: false })); }
  }

  async function handleAssignCard(user: AccessUser) {
    setCardAssigning(user.id);
    toast.info("Tap the NFC card on the device reader now...", { duration: 22000, id: `card-${user.id}` });
    try {
      const res = await fetch("/api/cosec/assign-card", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: user.id }),
      });
      const result = await res.json();
      toast.dismiss(`card-${user.id}`);
      if (result.ok) {
        toast.success(`Card assigned: ${result.cardNumber}`);
        await load();
      } else {
        toast.error(result.error || "Card read failed. Try again.");
      }
    } catch {
      toast.dismiss(`card-${user.id}`);
      toast.error("Card assignment failed.");
    } finally {
      setCardAssigning(null);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin text-muted-foreground" size={28} /></div>;
  }
  if (!device) return null;

  const isOnline = pingResult ? pingResult.ok : device.last_ping_success;
  const presentCount = presence.filter(p => p.is_inside).length;
  const deniedCount  = logs.filter(l => l.direction === "DENIED").length;

  // Build 7-day bar chart data from logs
  const sevenDayData: { label: string; IN: number; OUT: number; DENIED: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    const label = DAY_NAMES[d.getDay()];
    const dayStr = d.toISOString().split("T")[0];
    const dayLogs = logs.filter(l => l.event_time.startsWith(dayStr));
    sevenDayData.push({
      label,
      IN:     dayLogs.filter(l => l.direction === "IN").length,
      OUT:    dayLogs.filter(l => l.direction === "OUT").length,
      DENIED: dayLogs.filter(l => l.direction === "DENIED").length,
    });
  }

  // Heatmap max for colour scaling
  const heatmapMax = Math.max(...heatmap.map(h => h.count), 1);

  function heatColor(count: number): string {
    const idx = Math.min(Math.floor((count / heatmapMax) * (HEATMAP_COLORS.length - 1)), HEATMAP_COLORS.length - 1);
    return HEATMAP_COLORS[idx];
  }

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-6">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <Button variant="ghost" size="icon" onClick={() => router.push("/admin/cosec-devices")} className="mt-0.5">
            <ArrowLeft size={18} />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold flex items-center gap-2 flex-wrap">
              {isOnline === true ? <Wifi size={20} className="text-green-500" /> : isOnline === false ? <WifiOff size={20} className="text-red-500" /> : <Wifi size={20} className="text-muted-foreground opacity-40" />}
              {device.label}
              <Badge variant={device.is_enabled ? "default" : "secondary"} className="text-xs">{device.is_enabled ? "Enabled" : "Disabled"}</Badge>
              {/* Device category segmented control */}
              <span className="inline-flex rounded-md border text-xs overflow-hidden select-none" title="Entry Point: permanent member enrollment (biometric/card). Business Centre: temporary booking-based PIN access only.">
                <button
                  onClick={() => handleSetDeviceCategory("entry_point")}
                  className={`px-2.5 py-1 transition-colors ${device.device_category === "entry_point" ? "bg-blue-600 text-white font-medium" : "bg-white text-muted-foreground hover:bg-blue-50 hover:text-blue-700"}`}
                >
                  Entry Point
                </button>
                <button
                  onClick={() => handleSetDeviceCategory("business_centre")}
                  className={`px-2.5 py-1 border-l transition-colors ${device.device_category === "business_centre" ? "bg-amber-500 text-white font-medium" : "bg-white text-muted-foreground hover:bg-amber-50 hover:text-amber-700"}`}
                >
                  Business Centre
                </button>
              </span>
              {/* Reader capability segmented control */}
              <span className="inline-flex rounded-md border text-xs overflow-hidden select-none" title="Biometric + NFC: fingerprint scanner present. NFC Card Only: no fingerprint scanner.">
                <button
                  onClick={() => handleSetBiometricCapability(true)}
                  className={`px-2.5 py-1 transition-colors ${device.supports_biometric ? "bg-green-600 text-white font-medium" : "bg-white text-muted-foreground hover:bg-green-50 hover:text-green-700"}`}
                >
                  Biometric + NFC
                </button>
                <button
                  onClick={() => handleSetBiometricCapability(false)}
                  className={`px-2.5 py-1 border-l transition-colors ${!device.supports_biometric ? "bg-slate-600 text-white font-medium" : "bg-white text-muted-foreground hover:bg-slate-50 hover:text-slate-700"}`}
                >
                  NFC Card Only
                </button>
              </span>
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {(device.location as { name: string })?.name} · {device.device_ip}:{device.device_port}
            </p>
            <div className="flex flex-wrap gap-4 mt-1 text-xs text-muted-foreground">
              {device.last_ping_at    && <span>Ping: {formatDate(device.last_ping_at)}</span>}
              {device.last_polled_at  && <span>Last sync: {formatDate(device.last_polled_at)}</span>}
              <span>Seq #{device.last_seq_number}</span>
            </div>
            {pingResult && (
              <p className={`text-xs font-medium mt-1 ${pingResult.ok ? "text-green-600" : "text-red-500"}`}>
                {pingResult.ok ? `✓ ${pingResult.deviceName} · ${pingResult.latencyMs}ms` : `✗ ${pingResult.error}`}
              </p>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={handlePing} disabled={pinging}>
            {pinging ? <Loader2 size={14} className="animate-spin mr-1" /> : <Wifi size={14} className="mr-1" />}Ping
          </Button>
          <Button size="sm" variant="outline" onClick={handleOpenDoor} disabled={openingDoor}>
            {openingDoor ? <Loader2 size={14} className="animate-spin mr-1" /> : <DoorOpen size={14} className="mr-1" />}Open Door
          </Button>
        </div>
      </div>

      {/* ── Summary stats ──────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {(["provisioned", "biometric_enrolled", "card_enrolled", "fully_enrolled"] as const).map(status => {
          const count = users.filter(u => u.enrollment_status === status).length;
          return (
            <Card key={status} className="py-3">
              <CardContent className="px-4 py-0">
                <p className="text-xs text-muted-foreground">{STATUS_CONFIG[status].label}</p>
                <p className="text-2xl font-semibold mt-1">{count}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* 7-day quick chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2"><BarChart3 size={14} />Last 7 Days — Access Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={140}>
            <BarChart data={sevenDayData} margin={{ top: 0, right: 0, left: -20, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
              <XAxis dataKey="label" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
              <Tooltip />
              <Bar dataKey="IN" fill="#00AE6C" radius={[2, 2, 0, 0]} name="Entry" />
              <Bar dataKey="OUT" fill="#0284c7" radius={[2, 2, 0, 0]} name="Exit" />
              <Bar dataKey="DENIED" fill="#ef4444" radius={[2, 2, 0, 0]} name="Denied" />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <Tabs value={activeTab} onValueChange={(v) => { setActiveTab(v); if (v === "analytics") loadAnalytics(); if (v === "unlinked") { loadUnlinked(); loadContracts(); } }}>
        <TabsList>
          <TabsTrigger value="users" className="flex items-center gap-1.5">
            <Users size={13} />Enrolled ({users.length})
          </TabsTrigger>
          <TabsTrigger value="logs" className="flex items-center gap-1.5">
            <LogIn size={13} />Log ({logs.length})
            {deniedCount > 0 && (
              <span className="ml-1 bg-red-500 text-white text-[10px] rounded-full px-1.5 py-0.5 leading-none">{deniedCount}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="unlinked" className="flex items-center gap-1.5">
            <AlertTriangle size={13} />Unlinked
            {unlinked.length > 0 && (
              <span className="ml-1 bg-amber-500 text-white text-[10px] rounded-full px-1.5 py-0.5 leading-none">{unlinked.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="live" className="flex items-center gap-1.5">
            <MonitorSmartphone size={13} />Live Device
            {liveUsers.length > 0 && (
              <span className="ml-1 bg-violet-500 text-white text-[10px] rounded-full px-1.5 py-0.5 leading-none">{liveUsers.length}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="analytics" className="flex items-center gap-1.5">
            <TrendingUp size={13} />Analytics
          </TabsTrigger>
        </TabsList>

        {/* ── Enrolled Users ─────────────────────────────────────────────── */}
        <TabsContent value="users" className="mt-4">
          {/* Banner: legacy device users not yet in the system */}
          {(() => {
            const unlinkedCount = liveUsers.filter(u => !u.is_linked).length;
            if (unlinkedCount === 0) return null;
            return (
              <div className="mb-3 flex items-start gap-2.5 rounded-md border border-violet-200 bg-violet-50/60 px-4 py-3 text-sm text-violet-800">
                <MonitorSmartphone size={15} className="mt-0.5 shrink-0 text-violet-600" />
                <span>
                  <strong>{unlinkedCount} user{unlinkedCount !== 1 ? "s" : ""}</strong> enrolled on the device
                  {liveLoading ? " (loading…)" : ""} are not linked to any contract or employee record in the system.
                  {" "}
                  <button
                    className="font-semibold underline underline-offset-2 hover:text-violet-900"
                    onClick={() => setActiveTab("live")}
                  >
                    View on Live Device tab →
                  </button>
                </span>
              </div>
            );
          })()}
          {users.length === 0 ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <Fingerprint size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">No users enrolled</p>
              <p className="text-sm mt-1">Users are provisioned automatically on contract activation.</p>
            </CardContent></Card>
          ) : (
            <div className="space-y-2">
              {users.map(user => {
                const cfg = STATUS_CONFIG[user.enrollment_status] || STATUS_CONFIG.pending;
                const isBlocked = user.enrollment_status === "blocked";
                const isLoading = actionLoading[user.id];
                const isReprovLoading = actionLoading[`reprov_${user.id}`];
                const isAssigningCard = cardAssigning === user.id;
                const canAssignCard = !isBlocked && (user.enrollment_status === "biometric_enrolled" || user.enrollment_status === "provisioned" || user.enrollment_status === "card_enrolled" || user.enrollment_status === "fully_enrolled");

                // Denial count from logs for this entity
                const denials = logs.filter(l => l.direction === "DENIED" && l.entity_name === user.entity_name).length;

                return (
                  <Card key={user.id} className={isBlocked ? "opacity-60" : ""}>
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{user.entity_name}</span>
                            {user.contract_number && (
                              <span className="font-mono text-xs text-muted-foreground shrink-0">#{user.contract_number}</span>
                            )}
                            <Badge variant="outline" className="text-xs shrink-0">{TYPE_LABELS[user.user_type] ?? user.user_type}</Badge>
                            <Badge variant={cfg.variant} className="text-xs shrink-0">{cfg.label}</Badge>
                            {denials > 0 && (
                              <Badge variant="destructive" className="text-xs shrink-0 flex items-center gap-0.5">
                                <AlertTriangle size={10} />{denials} denied
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                            {user.phone && (
                              <span className="font-medium text-foreground">{user.phone}</span>
                            )}
                            {user.nfc_card_number
                              ? <span className="flex items-center gap-1 text-violet-600"><CreditCard size={11} />{user.nfc_card_number}</span>
                              : canAssignCard && <span className="flex items-center gap-1 text-amber-600"><CreditCard size={11} />No card assigned</span>
                            }
                            {user.biometric_enrolled_at && <span className="flex items-center gap-1"><Fingerprint size={10} />Enrolled {formatDate(user.biometric_enrolled_at)}</span>}
                            {user.card_enrolled_at && <span>Card issued {formatDate(user.card_enrolled_at)}</span>}
                            {user.valid_until && <span>Valid until {formatDate(user.valid_until)}</span>}
                            {user.provisioned_at && !user.biometric_enrolled_at && <span>Provisioned {formatDate(user.provisioned_at)}</span>}
                            {user.blocked_at && <span className="text-red-500">Blocked {formatDate(user.blocked_at)}</span>}
                          </div>
                        </div>
                        <div className="flex gap-1.5 shrink-0 flex-wrap justify-end">
                          {/* Assign Card */}
                          {canAssignCard && (
                            <Button size="sm" variant="outline" className="text-xs h-7"
                              onClick={() => handleAssignCard(user)} disabled={isAssigningCard || cardAssigning !== null}>
                              {isAssigningCard
                                ? <><Loader2 size={12} className="animate-spin mr-1" />Waiting…</>
                                : <><CreditCard size={12} className="mr-1" />Assign Card</>}
                            </Button>
                          )}
                          {/* Re-provision */}
                          <Button size="sm" variant="ghost" className="text-xs h-7 w-7 p-0" onClick={() => handleReprovision(user)} disabled={isReprovLoading} title="Re-provision on device">
                            {isReprovLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                          </Button>
                          {/* Block / Restore */}
                          {isBlocked ? (
                            <Button size="sm" variant="outline" className="text-xs h-7" onClick={() => handleRestore(user)} disabled={isLoading}>
                              {isLoading ? <Loader2 size={12} className="animate-spin mr-1" /> : <ShieldCheck size={12} className="mr-1" />}Restore
                            </Button>
                          ) : (
                            <Button size="sm" variant="outline" className="text-xs h-7 text-red-600 hover:text-red-700" onClick={() => handleBlock(user)} disabled={isLoading}>
                              {isLoading ? <Loader2 size={12} className="animate-spin mr-1" /> : <ShieldOff size={12} className="mr-1" />}Block
                            </Button>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </TabsContent>

        {/* ── Access Log ─────────────────────────────────────────────────── */}
        <TabsContent value="logs" className="mt-4">
          {logs.length === 0 ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <Clock size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">No access events yet</p>
              <p className="text-sm mt-1">Events appear once the 5-minute cron polls the device.</p>
            </CardContent></Card>
          ) : (
            <Card><CardContent className="p-0">
              <div className="divide-y">
                {logs.map(log => (
                  <div key={log.id} className={`flex items-center gap-3 px-4 py-2.5 ${log.direction === "DENIED" ? "bg-red-50/40" : ""}`}>
                    <div className="shrink-0">
                      {log.direction === "IN"     ? <LogIn  size={15} className="text-green-500" />
                       : log.direction === "OUT"  ? <LogOut size={15} className="text-blue-500" />
                                                  : <Ban    size={15} className="text-red-400" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-sm">{log.entity_name || `Ref #${log.cosec_ref_id}`}</span>
                      <span className="text-xs text-muted-foreground ml-2">{TYPE_LABELS[log.user_type] ?? log.user_type}</span>
                      {log.denial_reason && (
                        <span className="ml-2 text-xs text-red-500">· {log.denial_reason}</span>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <Badge variant={log.direction === "DENIED" ? "destructive" : "outline"} className="text-xs">{log.direction}</Badge>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {formatDate(log.event_time)}{" "}
                        <span className="font-mono">
                          {new Date(log.event_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "Asia/Kolkata" })}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent></Card>
          )}
        </TabsContent>

        {/* ── Unlinked ───────────────────────────────────────────────────── */}
        <TabsContent value="unlinked" className="mt-4">
          {unlinkedLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="animate-spin text-muted-foreground" size={24} /></div>
          ) : unlinked.length === 0 ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <ShieldCheck size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">No unlinked enrollments</p>
              <p className="text-sm mt-1">All ref IDs with access logs are linked to a contract, employee or booking.</p>
            </CardContent></Card>
          ) : (
            <>
              <p className="text-sm text-muted-foreground mb-3">
                {unlinked.length} ref ID{unlinked.length !== 1 ? "s" : ""} with access events are not yet linked to any contract or user. Link them so their logs are attributed correctly.
              </p>
              <div className="space-y-2">
                {unlinked.map(ref => (
                  <Card key={ref.cosec_ref_id}>
                    <CardContent className="py-3 px-4">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono font-medium text-sm">Ref #{ref.cosec_ref_id}</span>
                            <Badge variant="outline" className="text-xs">{ref.entry_count} events</Badge>
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                            <span>Last seen: {formatDate(ref.last_seen)}</span>
                            {ref.directions.IN > 0 && <span className="text-green-600">↑ {ref.directions.IN} in</span>}
                            {ref.directions.OUT > 0 && <span className="text-blue-600">↓ {ref.directions.OUT} out</span>}
                            {ref.directions.DENIED > 0 && <span className="text-red-500">✗ {ref.directions.DENIED} denied</span>}
                          </div>
                        </div>
                        <Button size="sm" variant="outline" className="text-xs h-7 shrink-0"
                          onClick={() => { setLinkDialog({ open: true, ref }); setSelectedContract(""); setContractSearch(""); }}>
                          Link to Contract
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {/* Link dialog */}
              {linkDialog.open && linkDialog.ref && (
                <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
                  <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6 space-y-4">
                    <div>
                      <h2 className="text-lg font-semibold">Link Ref #{linkDialog.ref.cosec_ref_id}</h2>
                      <p className="text-sm text-muted-foreground mt-1">
                        Select the contract this enrolled user belongs to. The device will be queried automatically to discover their COSEC user ID.
                      </p>
                    </div>
                    <div>
                      <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Search contract</label>
                      <input
                        className="w-full border rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
                        placeholder="Company name or contract #..."
                        value={contractSearch}
                        onChange={e => setContractSearch(e.target.value)}
                      />
                    </div>
                    <div className="max-h-52 overflow-y-auto border rounded-md divide-y">
                      {contracts
                        .filter(c => !contractSearch || c.entity_name.toLowerCase().includes(contractSearch.toLowerCase()) || c.contract_number.toLowerCase().includes(contractSearch.toLowerCase()))
                        .map(c => (
                          <div key={c.id}
                            className={`px-3 py-2.5 cursor-pointer text-sm hover:bg-muted/40 ${selectedContract === c.id ? "bg-primary/5 font-medium" : ""}`}
                            onClick={() => setSelectedContract(c.id)}>
                            <div className="flex items-center justify-between">
                              <span>{c.entity_name}</span>
                              <Badge variant="outline" className="text-xs ml-2 shrink-0">{c.contract_number}</Badge>
                            </div>
                            {c.valid_until && <p className="text-xs text-muted-foreground mt-0.5">Valid until {formatDate(c.valid_until)}</p>}
                          </div>
                        ))}
                      {contracts.filter(c => !contractSearch || c.entity_name.toLowerCase().includes(contractSearch.toLowerCase()) || c.contract_number.toLowerCase().includes(contractSearch.toLowerCase())).length === 0 && (
                        <p className="text-sm text-muted-foreground text-center py-4">No contracts found</p>
                      )}
                    </div>
                    <div className="flex gap-2 justify-end pt-2">
                      <Button variant="outline" size="sm" onClick={() => setLinkDialog({ open: false, ref: null })} disabled={linking}>
                        Cancel
                      </Button>
                      <Button size="sm" onClick={handleLink} disabled={!selectedContract || linking}>
                        {linking ? <><Loader2 size={13} className="animate-spin mr-1" />Linking…</> : "Link"}
                      </Button>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </TabsContent>

        {/* ── Live Device ────────────────────────────────────────────────── */}
        <TabsContent value="live" className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-sm font-medium">Enrolled on Device</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Live data fetched directly from the COSEC reader — includes legacy users enrolled before this app was connected.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex rounded-md border text-xs overflow-hidden">
                <button
                  onClick={() => setLiveFilter("all")}
                  className={`px-3 py-1.5 transition-colors ${liveFilter === "all" ? "bg-primary text-primary-foreground font-medium" : "bg-white text-muted-foreground hover:bg-muted/40"}`}
                >
                  All ({liveUsers.length})
                </button>
                <button
                  onClick={() => setLiveFilter("unlinked")}
                  className={`px-3 py-1.5 border-l transition-colors ${liveFilter === "unlinked" ? "bg-amber-500 text-white font-medium" : "bg-white text-muted-foreground hover:bg-amber-50"}`}
                >
                  Unlinked ({liveUsers.filter(u => !u.is_linked).length})
                </button>
              </div>
              <Button size="sm" variant="outline" onClick={loadLiveUsers} disabled={liveLoading} className="h-8 gap-1.5">
                {liveLoading ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />}
                Refresh
              </Button>
            </div>
          </div>

          {liveLoading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="animate-spin text-muted-foreground" size={24} />
              <span className="ml-2 text-sm text-muted-foreground">Querying device…</span>
            </div>
          ) : liveError ? (
            <Card><CardContent className="py-10 text-center">
              <WifiOff size={32} className="mx-auto mb-2 text-red-400" />
              <p className="font-medium text-sm text-red-600">{liveError}</p>
              <p className="text-xs text-muted-foreground mt-1">Check device connectivity, then try again.</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={loadLiveUsers}>Retry</Button>
            </CardContent></Card>
          ) : liveUsers.length === 0 ? (
            <Card><CardContent className="py-12 text-center text-muted-foreground">
              <MonitorSmartphone size={36} className="mx-auto mb-3 opacity-30" />
              <p className="font-medium">No enrolled users found on device</p>
              <p className="text-sm mt-1">Click Refresh to query the device.</p>
            </CardContent></Card>
          ) : (
            <div className="space-y-2">
              {liveUsers
                .filter(u => liveFilter === "all" || !u.is_linked)
                .map((u) => (
                  <Card key={u.user_id} className={!u.is_active ? "opacity-60" : ""}>
                    <CardContent className="py-3 px-4">
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-sm">{u.name || u.user_id}</span>
                            <span className="font-mono text-xs text-muted-foreground">Ref #{u.ref_user_id}</span>
                            {u.is_linked ? (
                              <Badge variant="outline" className="text-xs border-green-400 text-green-700 bg-green-50 gap-1">
                                <CheckCircle2 size={10} />Linked{u.entity_name ? ` · ${u.entity_name}` : ""}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-xs border-amber-400 text-amber-700 bg-amber-50 gap-1">
                                <AlertTriangle size={10} />Not in system
                              </Badge>
                            )}
                            {!u.is_active && <Badge variant="secondary" className="text-xs">Inactive</Badge>}
                            {u.enrollment_status && (
                              <Badge variant="outline" className="text-xs">
                                {STATUS_CONFIG[u.enrollment_status]?.label ?? u.enrollment_status}
                              </Badge>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                            <span className="font-mono">{u.user_id}</span>
                            {u.finger_count > 0 ? (
                              <span className="flex items-center gap-1 text-green-600">
                                <Fingerprint size={11} />{u.finger_count} fingerprint{u.finger_count !== 1 ? "s" : ""}
                              </span>
                            ) : (
                              <span className="flex items-center gap-1 text-muted-foreground">
                                <XCircle size={11} />No biometric
                              </span>
                            )}
                            {u.card_number ? (
                              <span className="flex items-center gap-1 text-violet-600">
                                <CreditCard size={11} />{u.card_number}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">No card</span>
                            )}
                          </div>
                        </div>
                        {!u.is_linked && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="text-xs h-7 shrink-0"
                            onClick={() => {
                              // Pre-populate the link dialog with this ref ID
                              setLinkDialog({ open: true, ref: { cosec_ref_id: u.ref_user_id, entry_count: 0, last_seen: "", directions: { IN: 0, OUT: 0, DENIED: 0 } } });
                              setSelectedContract("");
                              setContractSearch("");
                            }}
                          >
                            Link to Contract
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))}
            </div>
          )}
        </TabsContent>

        {/* ── Analytics ──────────────────────────────────────────────────── */}
        <TabsContent value="analytics" className="mt-4 space-y-6">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">Analytics window</p>
            <div className="flex gap-1.5">
              {[7, 14, 30, 90].map(d => (
                <Button key={d} size="sm" variant={analyticsDays === d ? "default" : "outline"}
                  className="text-xs h-7" onClick={() => { setAnalyticsDays(d); loadAnalytics(); }}>
                  {d}d
                </Button>
              ))}
            </div>
          </div>

          {analyticsLoading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="animate-spin text-muted-foreground" size={28} /></div>
          ) : (
            <>
              {/* Live Presence */}
              <div className="grid grid-cols-2 gap-3">
                <Card>
                  <CardContent className="py-4 px-5">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2"><Users size={12} />Inside right now</div>
                    <p className="text-3xl font-bold text-green-600">{presentCount}</p>
                    <p className="text-xs text-muted-foreground mt-1">of {presence.length} tracked</p>
                    {presence.filter(p => p.is_inside).length > 0 && (
                      <div className="mt-2 space-y-0.5">
                        {presence.filter(p => p.is_inside).slice(0, 5).map(p => (
                          <p key={p.entity_id} className="text-xs text-muted-foreground flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
                            {p.entity_name}
                          </p>
                        ))}
                        {presence.filter(p => p.is_inside).length > 5 && (
                          <p className="text-xs text-muted-foreground">+{presence.filter(p => p.is_inside).length - 5} more</p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="py-4 px-5">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-2"><AlertTriangle size={12} />Denial flags ({analyticsDays}d)</div>
                    <p className="text-3xl font-bold text-red-600">{denialSummary.reduce((s, d) => s + d.count, 0)}</p>
                    <p className="text-xs text-muted-foreground mt-1">{denialSummary.length} unique entities</p>
                    {denialSummary.slice(0, 3).map((d, i) => (
                      <p key={i} className="text-xs text-muted-foreground mt-1 truncate">
                        {d.entity_name}: {d.count}× — {Object.keys(d.reasons)[0] ?? ""}
                      </p>
                    ))}
                  </CardContent>
                </Card>
              </div>

              {/* Heatmap — hour × day of week */}
              {heatmap.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Peak Hours Heatmap</CardTitle>
                    <p className="text-xs text-muted-foreground">Entry frequency by hour and day of week (IST) · last {analyticsDays} days</p>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-x-auto">
                      <table className="text-[10px] border-collapse w-full">
                        <thead>
                          <tr>
                            <th className="pr-2 text-right text-muted-foreground font-normal w-8" />
                            {Array.from({ length: 24 }, (_, h) => (
                              <th key={h} className="text-center text-muted-foreground font-normal pb-1 px-px"
                                style={{ minWidth: 18 }}>
                                {h === 0 ? "12a" : h < 12 ? h : h === 12 ? "12p" : h - 12}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {DAY_NAMES.map((day, dow) => (
                            <tr key={dow}>
                              <td className="pr-2 text-right text-muted-foreground py-px">{day}</td>
                              {Array.from({ length: 24 }, (_, hour) => {
                                const cell = heatmap.find(h => h.day === dow && h.hour === hour);
                                const count = cell?.count ?? 0;
                                return (
                                  <td key={hour} className="rounded-sm p-px" title={`${day} ${hour}:00 — ${count} entries`}>
                                    <div className="w-4 h-4 rounded-sm flex items-center justify-center"
                                      style={{ backgroundColor: heatColor(count) }}>
                                      {count > 0 && (
                                        <span className="text-[8px] font-medium" style={{ color: count / heatmapMax > 0.5 ? "#fff" : "#374151" }}>
                                          {count}
                                        </span>
                                      )}
                                    </div>
                                  </td>
                                );
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                      <span>Low</span>
                      {HEATMAP_COLORS.map((c, i) => <span key={i} className="w-4 h-3 rounded-sm inline-block" style={{ backgroundColor: c }} />)}
                      <span>High</span>
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Attendance table */}
              {attendance.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Attendance Summary</CardTitle>
                    <p className="text-xs text-muted-foreground">Unique days visited · last {analyticsDays} days · sorted by frequency</p>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y">
                      {attendance.map((a, i) => (
                        <div key={a.entity_id} className="flex items-center gap-4 px-4 py-2.5">
                          <span className="text-muted-foreground text-xs w-5 shrink-0">{i + 1}</span>
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-sm truncate block">{a.entity_name}</span>
                            <span className="text-xs text-muted-foreground">{TYPE_LABELS[a.user_type] ?? a.user_type}</span>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-semibold text-sm">{a.unique_days} <span className="font-normal text-muted-foreground text-xs">days</span></p>
                            <p className="text-xs text-muted-foreground">{a.total_entries} entries · last {formatDate(a.last_seen)}</p>
                          </div>
                          <div className="w-20 bg-muted/40 rounded-full h-1.5 shrink-0">
                            <div className="bg-primary h-1.5 rounded-full" style={{ width: `${Math.min((a.unique_days / analyticsDays) * 100, 100)}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {/* Denial detail */}
              {denialSummary.length > 0 && (
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2"><AlertTriangle size={13} className="text-red-500" />Denial Flags</CardTitle>
                    <p className="text-xs text-muted-foreground">Entities with failed access attempts — investigate if repeated</p>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="divide-y">
                      {denialSummary.map((d, i) => (
                        <div key={i} className="flex items-center gap-4 px-4 py-2.5">
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-sm">{d.entity_name}</span>
                            <div className="flex flex-wrap gap-1.5 mt-0.5">
                              {Object.entries(d.reasons).map(([reason, count]) => (
                                <span key={reason} className="text-xs bg-red-50 text-red-700 rounded px-1.5 py-0.5">
                                  {reason}: {count}×
                                </span>
                              ))}
                            </div>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="font-bold text-red-600 text-lg">{d.count}</p>
                            <p className="text-xs text-muted-foreground">last {formatDate(d.last_denied_at)}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}

              {attendance.length === 0 && heatmap.every(h => h.count === 0) && (
                <Card><CardContent className="py-12 text-center text-muted-foreground">
                  <BarChart3 size={36} className="mx-auto mb-3 opacity-30" />
                  <p className="font-medium">No analytics data yet</p>
                  <p className="text-sm mt-1">Analytics populate once the device starts logging access events.</p>
                </CardContent></Card>
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}

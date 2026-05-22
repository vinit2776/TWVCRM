"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  AlertTriangle, Fingerprint, CreditCard, Loader2,
  ShieldOff, ShieldCheck, RefreshCw, Search, Filter,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Enrollment {
  id: string;
  device_id: string;
  device_label: string;
  device_category: "entry_point" | "business_centre";
  location_name: string;
  cosec_user_id: string;
  cosec_ref_id: number;
  user_type: "contract" | "employee" | "booking" | "member";
  entity_id: string;
  entity_name: string;
  contract_id?: string;
  contract_number?: string;
  contract_status?: string;
  end_date?: string | null;
  enrollment_status: string;
  access_pin: string | null;
  nfc_card_number: string | null;
  valid_until: string | null;
  provisioned_at: string | null;
  biometric_enrolled_at: string | null;
  card_enrolled_at: string | null;
  blocked_at: string | null;
  is_legacy: boolean;
  legacy_reason: string;
}

interface Meta {
  total: number;
  legacy: number;
  byType: Record<string, number>;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const TYPE_LABELS: Record<string, string> = {
  contract: "Contract", employee: "Employee", booking: "Booking", member: "Member",
};

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending:            { label: "Pending",            className: "bg-gray-100 text-gray-600" },
  provisioned:        { label: "Provisioned",        className: "bg-blue-50 text-blue-700 border-blue-200" },
  biometric_enrolled: { label: "Biometric",          className: "bg-green-50 text-green-700 border-green-200" },
  card_enrolled:      { label: "Card",               className: "bg-purple-50 text-purple-700 border-purple-200" },
  fully_enrolled:     { label: "Fully Enrolled",     className: "bg-green-100 text-green-800 border-green-300" },
  blocked:            { label: "Blocked",            className: "bg-red-50 text-red-700 border-red-200" },
};

const CONTRACT_STATUS_COLORS: Record<string, string> = {
  active:     "text-green-700",
  terminated: "text-red-600",
  cancelled:  "text-red-600",
  expired:    "text-amber-600",
  pending:    "text-blue-600",
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CosecAccessPage() {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [loading, setLoading] = useState(true);

  // Filter state
  const [tab, setTab]             = useState<"all" | "legacy" | "blocked">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [deviceFilter, setDeviceFilter] = useState<string>("all");
  const [search, setSearch]       = useState("");

  // Action state
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/cosec/enrollments");
      const json = await res.json();
      setEnrollments(json.data ?? []);
      setMeta(json.meta ?? null);
    } catch {
      toast.error("Failed to load enrollments");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Derived: unique devices for filter dropdown
  const deviceOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of enrollments) {
      if (!seen.has(e.device_id)) seen.set(e.device_id, e.device_label);
    }
    return [...seen.entries()];
  }, [enrollments]);

  // Filtered list
  const filtered = useMemo(() => {
    return enrollments.filter(e => {
      if (tab === "legacy"  && !e.is_legacy) return false;
      if (tab === "blocked" && e.enrollment_status !== "blocked") return false;
      if (typeFilter !== "all" && e.user_type !== typeFilter) return false;
      if (deviceFilter !== "all" && e.device_id !== deviceFilter) return false;
      if (search) {
        const q = search.toLowerCase();
        if (
          !e.entity_name.toLowerCase().includes(q) &&
          !(e.contract_number ?? "").toLowerCase().includes(q) &&
          !e.device_label.toLowerCase().includes(q) &&
          !e.cosec_user_id.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [enrollments, tab, typeFilter, deviceFilter, search]);

  // ── Actions ────────────────────────────────────────────────────────────────

  async function handleBlock(enrollment: Enrollment) {
    setActionLoading(a => ({ ...a, [enrollment.id]: true }));
    try {
      const res = await fetch("/api/cosec/block-user", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: enrollment.id }),
      });
      const result = await res.json();
      if (result.ok) { toast.success("Access blocked"); await load(); }
      else toast.error(result.error || "Failed to block");
    } finally {
      setActionLoading(a => ({ ...a, [enrollment.id]: false }));
    }
  }

  async function handleRestore(enrollment: Enrollment) {
    setActionLoading(a => ({ ...a, [enrollment.id]: true }));
    try {
      const res = await fetch("/api/cosec/restore-user", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: enrollment.id }),
      });
      const result = await res.json();
      if (result.ok) { toast.success("Access restored"); await load(); }
      else toast.error(result.error || "Failed to restore");
    } finally {
      setActionLoading(a => ({ ...a, [enrollment.id]: false }));
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-5xl mx-auto p-6 space-y-5">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Access Enrollments</h1>
          <p className="text-sm text-muted-foreground mt-1">
            All biometric enrollments across every COSEC device. Legacy enrollments are contracts or bookings that have ended but still have active access.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={load} disabled={loading}>
          <RefreshCw size={14} className={`mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {/* Summary stats */}
      {meta && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card className="py-3">
            <CardContent className="px-4 py-0">
              <p className="text-xs text-muted-foreground">Total Enrollments</p>
              <p className="text-2xl font-semibold mt-1">{meta.total}</p>
            </CardContent>
          </Card>
          <Card className={`py-3 ${meta.legacy > 0 ? "border-amber-300 bg-amber-50/30" : ""}`}>
            <CardContent className="px-4 py-0">
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {meta.legacy > 0 && <AlertTriangle size={11} className="text-amber-500" />}
                Legacy (needs cleanup)
              </p>
              <p className={`text-2xl font-semibold mt-1 ${meta.legacy > 0 ? "text-amber-600" : ""}`}>
                {meta.legacy}
              </p>
            </CardContent>
          </Card>
          <Card className="py-3">
            <CardContent className="px-4 py-0">
              <p className="text-xs text-muted-foreground">Contracts + Members</p>
              <p className="text-2xl font-semibold mt-1">
                {(meta.byType.contract ?? 0) + (meta.byType.member ?? 0)}
              </p>
            </CardContent>
          </Card>
          <Card className="py-3">
            <CardContent className="px-4 py-0">
              <p className="text-xs text-muted-foreground">Bookings</p>
              <p className="text-2xl font-semibold mt-1">{meta.byType.booking ?? 0}</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Tab filter */}
        <div className="inline-flex rounded-md border text-xs overflow-hidden">
          {(["all", "legacy", "blocked"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-3 py-1.5 capitalize transition-colors ${tab === t ? "bg-primary text-primary-foreground font-medium" : "bg-white text-muted-foreground hover:bg-muted/40"} ${t !== "all" ? "border-l" : ""}`}>
              {t === "legacy" && meta?.legacy ? `Legacy (${meta.legacy})` : t === "blocked" ? "Blocked" : "All"}
            </button>
          ))}
        </div>

        {/* Type filter */}
        <select
          value={typeFilter}
          onChange={e => setTypeFilter(e.target.value)}
          className="text-xs border rounded-md px-2.5 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-primary/30"
        >
          <option value="all">All types</option>
          <option value="contract">Contract</option>
          <option value="member">Member</option>
          <option value="employee">Employee</option>
          <option value="booking">Booking</option>
        </select>

        {/* Device filter */}
        {deviceOptions.length > 1 && (
          <select
            value={deviceFilter}
            onChange={e => setDeviceFilter(e.target.value)}
            className="text-xs border rounded-md px-2.5 py-1.5 bg-white focus:outline-none focus:ring-1 focus:ring-primary/30"
          >
            <option value="all">All devices</option>
            {deviceOptions.map(([id, label]) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        )}

        {/* Search */}
        <div className="relative ml-auto">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search name, contract, device…"
            className="pl-8 h-8 text-xs w-56"
          />
        </div>
      </div>

      {/* Results count */}
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
        <Filter size={11} />
        {filtered.length} of {enrollments.length} enrollments
      </p>

      {/* Enrollment list */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="animate-spin text-muted-foreground" size={28} />
        </div>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-14 text-center text-muted-foreground">
            <Fingerprint size={36} className="mx-auto mb-3 opacity-30" />
            <p className="font-medium">No enrollments match</p>
            <p className="text-sm mt-1">Adjust the filters above to see results.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map(e => {
            const statusCfg = STATUS_CONFIG[e.enrollment_status] ?? STATUS_CONFIG.pending;
            const isBlocked = e.enrollment_status === "blocked";
            const isLoading = actionLoading[e.id];

            return (
              <Card key={e.id}
                className={`${e.is_legacy ? "border-amber-300 bg-amber-50/20" : ""} ${isBlocked ? "opacity-60" : ""}`}>
                <CardContent className="py-3 px-4">
                  <div className="flex items-start justify-between gap-4">

                    {/* Left: identity + context */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        {/* Legacy warning chip */}
                        {e.is_legacy && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-100 border border-amber-300 rounded px-1.5 py-0.5">
                            <AlertTriangle size={10} />LEGACY
                          </span>
                        )}
                        <span className="font-medium text-sm">{e.entity_name}</span>
                        <Badge variant="outline" className="text-xs shrink-0">
                          {TYPE_LABELS[e.user_type] ?? e.user_type}
                        </Badge>
                        {e.contract_number && (
                          e.contract_id ? (
                            <Link
                              href={`/contracts/${e.contract_id}`}
                              className="text-xs font-mono shrink-0 text-blue-600 hover:underline"
                            >
                              #{e.contract_number}
                            </Link>
                          ) : (
                            <span className="text-xs text-muted-foreground font-mono shrink-0">
                              #{e.contract_number}
                            </span>
                          )
                        )}
                        {e.contract_status && (
                          <span className={`text-xs font-medium shrink-0 ${CONTRACT_STATUS_COLORS[e.contract_status] ?? "text-muted-foreground"}`}>
                            {e.contract_status}
                          </span>
                        )}
                      </div>

                      {/* Legacy reason */}
                      {e.is_legacy && e.legacy_reason && (
                        <p className="text-xs text-amber-700 mt-0.5 font-medium">{e.legacy_reason}</p>
                      )}

                      {/* Device + enrollment status row */}
                      <div className="flex flex-wrap items-center gap-2 mt-1">
                        <span className="text-xs text-muted-foreground">
                          {e.device_label}
                          {e.location_name && <> · {e.location_name}</>}
                        </span>
                        <span className={`inline-flex items-center text-[11px] px-1.5 py-0.5 rounded border font-medium ${statusCfg.className}`}>
                          {statusCfg.label}
                        </span>
                        {e.device_category === "business_centre" && (
                          <span className="text-[11px] px-1.5 py-0.5 rounded border border-amber-200 bg-amber-50 text-amber-700">
                            Business Centre
                          </span>
                        )}
                      </div>

                      {/* Meta row */}
                      <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                        {e.nfc_card_number && (
                          <span className="flex items-center gap-1">
                            <CreditCard size={11} />{e.nfc_card_number}
                          </span>
                        )}
                        {e.biometric_enrolled_at && (
                          <span className="flex items-center gap-1">
                            <Fingerprint size={10} />Enrolled {formatDate(e.biometric_enrolled_at)}
                          </span>
                        )}
                        {e.valid_until && (
                          <span>Valid until {formatDate(e.valid_until)}</span>
                        )}
                        {e.provisioned_at && (
                          <span>Provisioned {formatDate(e.provisioned_at)}</span>
                        )}
                        {e.blocked_at && (
                          <span className="text-red-500">Blocked {formatDate(e.blocked_at)}</span>
                        )}
                        <span className="font-mono text-[10px]">{e.cosec_user_id}</span>
                      </div>
                    </div>

                    {/* Right: actions */}
                    <div className="shrink-0">
                      {isBlocked ? (
                        <Button size="sm" variant="outline" className="text-xs h-7"
                          onClick={() => handleRestore(e)} disabled={isLoading}>
                          {isLoading
                            ? <Loader2 size={12} className="animate-spin mr-1" />
                            : <ShieldCheck size={12} className="mr-1" />}
                          Restore
                        </Button>
                      ) : (
                        <Button size="sm" variant="outline"
                          className={`text-xs h-7 ${e.is_legacy ? "border-amber-400 text-amber-700 hover:bg-amber-50" : "text-red-600 hover:text-red-700"}`}
                          onClick={() => handleBlock(e)} disabled={isLoading}>
                          {isLoading
                            ? <Loader2 size={12} className="animate-spin mr-1" />
                            : <ShieldOff size={12} className="mr-1" />}
                          Block
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
    </div>
  );
}

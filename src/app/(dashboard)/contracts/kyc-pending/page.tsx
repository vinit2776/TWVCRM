"use client";

/**
 * KYC Pending — single-page dashboard showing every contract that still has
 * required KYC documents in `pending` or `deferred` state. Same data the
 * Saturday email digest is built from, but available in-app on demand.
 *
 * Per-document quick actions (admin/manager):
 *   - Open contract → jumps to docs tab to upload
 *   - Clear deferral → flips status back to pending
 *   - Extend deadline → inline date picker for `deferred_until`
 *
 * Filters: status (all/pending/deferred), overdue-only, contract-status.
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Loader2, AlertTriangle, ExternalLink, X, Calendar, Clock, RefreshCcw,
  RotateCcw, ChevronDown, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

interface KycDoc {
  id: string;
  label: string;
  status: "pending" | "deferred";
  deferred_at: string | null;
  deferred_reason: string | null;
  deferred_until: string | null;
  deferrer_name: string | null;
  is_overdue: boolean;
}

interface KycContract {
  id: string;
  contract_number: string;
  status: string;
  customer_name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  location_id: string | null;
  location_name: string | null;
  created_at: string;
  docs: KycDoc[];
}

interface KycResponse {
  summary: {
    contracts: number;
    total_pending: number;
    total_deferred: number;
    total_overdue: number;
  };
  contracts: KycContract[];
}

type DocFilter = "all" | "pending" | "deferred";

export default function KycPendingPage() {
  const [data, setData] = useState<KycResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [docFilter, setDocFilter] = useState<DocFilter>("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [includeDrafts, setIncludeDrafts] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Per-doc inline edit state
  const [editingDocId, setEditingDocId] = useState<string | null>(null);
  const [editDateDraft, setEditDateDraft] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  const fetchData = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (docFilter !== "all") params.set("doc_status", docFilter);
    if (overdueOnly) params.set("overdue_only", "true");
    params.set("contract_status", includeDrafts ? "all" : "active,signed,pending_activation");
    const res = await fetch(`/api/contracts/kyc-pending?${params}`);
    const json = await res.json();
    setData(json);
    // Auto-expand contracts that have an overdue doc — staff sees them first
    const auto = new Set<string>();
    for (const c of (json.contracts ?? []) as KycContract[]) {
      if (c.docs.some((d) => d.is_overdue)) auto.add(c.id);
    }
    setExpanded(auto);
    setLoading(false);
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [docFilter, overdueOnly, includeDrafts]);

  const filtered = useMemo(() => {
    if (!data) return [];
    if (!search.trim()) return data.contracts;
    const q = search.toLowerCase();
    return data.contracts.filter((c) =>
      c.contract_number.toLowerCase().includes(q) ||
      c.customer_name.toLowerCase().includes(q) ||
      (c.company ?? "").toLowerCase().includes(q) ||
      (c.location_name ?? "").toLowerCase().includes(q) ||
      c.docs.some((d) => d.label.toLowerCase().includes(q))
    );
  }, [data, search]);

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearDeferral = async (contractId: string, docId: string, label: string) => {
    if (!confirm(`Clear deferral on "${label}"? It will revert to Pending.`)) return;
    const res = await fetch(`/api/contracts/${contractId}/documents/${docId}/defer`, { method: "DELETE" });
    if (res.ok) {
      toast.success("Deferral cleared");
      fetchData();
    } else {
      const j = await res.json().catch(() => null);
      toast.error(j?.error ?? "Failed to clear");
    }
  };

  const startEditDate = (doc: KycDoc) => {
    setEditingDocId(doc.id);
    setEditDateDraft(doc.deferred_until ?? "");
  };

  const saveDate = async (contractId: string, docId: string) => {
    setEditSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/documents/${docId}/defer`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defer_until: editDateDraft || null }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        toast.error(j?.error ?? "Failed to update");
        return;
      }
      toast.success("Deadline updated");
      setEditingDocId(null);
      fetchData();
    } finally {
      setEditSaving(false);
    }
  };

  const summary = data?.summary;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      <PageBreadcrumb resetTo={{ label: "KYC Pending" }} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-semibold">KYC Pending</h1>
          <p className="text-xs md:text-sm text-muted-foreground">
            Required KYC documents that are still <strong>Pending</strong> or
            have been <strong>Deferred</strong> on active customers. Same list the
            Saturday digest email is built from.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={fetchData} disabled={loading}>
          <RefreshCcw className={cn("h-4 w-4 mr-1.5", loading && "animate-spin")} /> Refresh
        </Button>
      </div>

      {/* Counter strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Counter label="Contracts" value={summary?.contracts ?? 0} />
        <Counter label="Pending" value={summary?.total_pending ?? 0} accent="amber" />
        <Counter label="Deferred" value={summary?.total_deferred ?? 0} accent="blue" />
        <Counter label="Overdue" value={summary?.total_overdue ?? 0} accent="red" highlight={(summary?.total_overdue ?? 0) > 0} />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-md border p-0.5 bg-background">
          {(["all", "pending", "deferred"] as DocFilter[]).map((f) => (
            <button
              key={f}
              onClick={() => setDocFilter(f)}
              className={cn(
                "px-3 py-1 text-xs rounded-sm capitalize transition",
                docFilter === f ? "bg-primary text-primary-foreground" : "hover:bg-muted/40",
              )}
            >{f}</button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={overdueOnly}
            onChange={(e) => setOverdueOnly(e.target.checked)}
            className="rounded"
          />
          Overdue only
        </label>
        <label className="flex items-center gap-1.5 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={includeDrafts}
            onChange={(e) => setIncludeDrafts(e.target.checked)}
            className="rounded"
          />
          Include drafts
        </label>
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search contract, customer, doc…"
          className="h-8 max-w-xs ml-auto"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-muted-foreground py-12 text-center border rounded-lg">
          {search.trim() ? "No matches for this search." : "No outstanding KYC. Nice."}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((c) => {
            const isOpen = expanded.has(c.id);
            const overdueCount  = c.docs.filter((d) => d.is_overdue).length;
            const deferredCount = c.docs.filter((d) => d.status === "deferred").length;
            const pendingCount  = c.docs.filter((d) => d.status === "pending").length;
            return (
              <div
                key={c.id}
                className={cn(
                  "rounded-lg border overflow-hidden",
                  overdueCount > 0 ? "border-red-300" : "border-border",
                )}
              >
                {/* Contract row */}
                <button
                  type="button"
                  onClick={() => toggle(c.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/30 text-left"
                >
                  {isOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" /> : <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="text-xs font-mono">{c.contract_number}</code>
                      <span className="text-sm font-medium truncate">{c.customer_name}</span>
                      {c.company && <span className="text-xs text-muted-foreground truncate">· {c.company}</span>}
                      <Badge variant="outline" className="text-[10px] capitalize">{c.status}</Badge>
                      {c.location_name && <span className="text-[11px] text-muted-foreground">{c.location_name}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {overdueCount > 0 && (
                      <Badge className="text-[10px] bg-red-100 text-red-700 border-red-300">
                        <AlertTriangle className="h-2.5 w-2.5 mr-0.5" /> {overdueCount} overdue
                      </Badge>
                    )}
                    {deferredCount > 0 && (
                      <Badge className="text-[10px] bg-blue-100 text-blue-700 border-blue-300">
                        {deferredCount} deferred
                      </Badge>
                    )}
                    {pendingCount > 0 && (
                      <Badge className="text-[10px] bg-amber-100 text-amber-700 border-amber-300">
                        {pendingCount} pending
                      </Badge>
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t bg-muted/10">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          <th className="text-left px-3 py-1.5 font-medium">Document</th>
                          <th className="text-left px-3 py-1.5 font-medium w-24">Status</th>
                          <th className="text-left px-3 py-1.5 font-medium">Reason / Deadline</th>
                          <th className="px-3 py-1.5 w-px whitespace-nowrap"></th>
                        </tr>
                      </thead>
                      <tbody>
                        {c.docs.map((d) => (
                          <tr key={d.id} className={cn("border-t", d.is_overdue && "bg-red-50/40")}>
                            <td className="px-3 py-2">{d.label}</td>
                            <td className="px-3 py-2">
                              {d.status === "deferred" ? (
                                <Badge className="text-[10px] bg-blue-100 text-blue-700 border-blue-300">Deferred</Badge>
                              ) : (
                                <Badge className="text-[10px] bg-amber-100 text-amber-700 border-amber-300">Pending</Badge>
                              )}
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {d.status === "deferred" ? (
                                <div className="flex flex-wrap items-center gap-2">
                                  {d.deferred_reason && (
                                    <span className="text-muted-foreground">{d.deferred_reason}</span>
                                  )}
                                  {editingDocId === d.id ? (
                                    <div className="flex items-center gap-1">
                                      <Input
                                        type="date"
                                        value={editDateDraft}
                                        onChange={(e) => setEditDateDraft(e.target.value)}
                                        className="h-6 text-xs w-[140px] py-0"
                                      />
                                      <Button
                                        size="sm" className="h-6 text-[10px] px-2"
                                        onClick={() => saveDate(c.id, d.id)} disabled={editSaving}
                                      >Save</Button>
                                      <Button
                                        size="sm" variant="ghost" className="h-6 text-[10px] px-1"
                                        onClick={() => setEditingDocId(null)}
                                      ><X className="h-3 w-3" /></Button>
                                    </div>
                                  ) : d.deferred_until ? (
                                    <button
                                      type="button"
                                      onClick={() => startEditDate(d)}
                                      className={cn(
                                        "inline-flex items-center gap-1 hover:underline",
                                        d.is_overdue ? "text-red-600 font-semibold" : "text-blue-700",
                                      )}
                                      title="Click to extend deadline"
                                    >
                                      {d.is_overdue ? <AlertTriangle className="h-3 w-3" /> : <Calendar className="h-3 w-3" />}
                                      {d.is_overdue ? "Overdue since " : "Until "}
                                      {fmtDate(d.deferred_until)}
                                    </button>
                                  ) : (
                                    <button
                                      type="button"
                                      onClick={() => startEditDate(d)}
                                      className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                                    >
                                      <Clock className="h-3 w-3" /> No deadline · set
                                    </button>
                                  )}
                                  {d.deferrer_name && (
                                    <span className="text-[10px] text-muted-foreground">by {d.deferrer_name}</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">Not yet uploaded</span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right whitespace-nowrap">
                              <div className="flex items-center justify-end gap-1">
                                {d.status === "deferred" && (
                                  <Button
                                    size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                                    onClick={() => clearDeferral(c.id, d.id, d.label)}
                                    title="Clear deferral (revert to Pending)"
                                  >
                                    <RotateCcw className="h-3 w-3 mr-1" /> Clear
                                  </Button>
                                )}
                                <Link
                                  href={`/contracts/${c.id}#documents`}
                                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                                >
                                  Open <ExternalLink className="h-3 w-3" />
                                </Link>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Counter({
  label, value, accent, highlight,
}: { label: string; value: number; accent?: "amber" | "blue" | "red"; highlight?: boolean }) {
  const accentClass =
    accent === "red"   ? "text-red-700"   :
    accent === "amber" ? "text-amber-700" :
    accent === "blue"  ? "text-blue-700"  : "text-foreground";
  return (
    <div className={cn(
      "rounded-lg border bg-card p-3",
      highlight && "border-red-300 ring-1 ring-red-200",
    )}>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={cn("text-2xl font-semibold mt-0.5", accentClass)}>{value}</div>
    </div>
  );
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric" });
}

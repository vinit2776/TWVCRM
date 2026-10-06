"use client";

import { useState, useEffect, useCallback, Fragment, useRef } from "react";
import Link from "next/link";
import {
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  Clock,
  AlertCircle,
  Banknote,
  ArrowDownToLine,
  Loader2,
  Filter,
  Search,
  CreditCard,
  Smartphone,
  Globe,
  ChevronDown,
  Link2,
  Unlink,
  History,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { FinanceGuideCard, GuideReopenButton } from "@/components/finance/finance-guide-card";
import { PageBreadcrumb } from "@/components/page-breadcrumb";

// ── Types ────────────────────────────────────────────────────────────────────

type EntityType =
  | "contract" | "booking" | "billing_statement"
  | "proposal" | "deposit_topup" | "prepaid_purchase" | "adhoc_invoice"
  | "unmatched";

interface GatewayTransaction {
  id: string;
  entity_type: EntityType;
  entity_id: string | null;
  entity_ref: string | null;
  entity_label: string;
  entity_href: string | null;
  customer_name: string;
  amount: number;
  razorpay_payment_id: string | null;
  payment_reference: string | null;
  captured: boolean;
  created_at: string;
  settled: boolean;
  settlement_id: string | null;
  settlement_utr: string | null;
  settled_at: string | null;
  fee: number | null;
  tax: number | null;
  payment_method: string | null;
  in_crm: boolean;
  manually_linked: boolean;
  link_notes: string | null;
  link_linked_at: string | null;
  link_linked_by: string | null;
}

interface SearchResult {
  entity_type: "contract" | "booking" | "billing_statement";
  entity_id: string;
  ref: string;
  customer: string;
  detail: string;
  status: string | null;
}

interface LinkLog {
  id: string;
  action: "linked" | "relinked" | "unlinked";
  old_entity_type: string | null;
  new_entity_type: string | null;
  new_entity_id: string | null;
  new_notes: string | null;
  performed_at: string;
  users: { full_name: string } | null;
}

interface Summary {
  total_captured: number;
  total_settled: number;
  total_pending: number;
  total_fees: number;
  count: number;
}

interface SyncLog {
  synced_at: string;
  records_updated: number;
  error_message: string | null;
}

// ── Helper components ────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  sub,
  color = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  color?: "default" | "green" | "amber" | "blue";
}) {
  const colors = {
    default: "bg-muted/40",
    green:   "bg-green-50 border-green-100",
    amber:   "bg-amber-50 border-amber-100",
    blue:    "bg-blue-50 border-blue-100",
  };
  const textColors = {
    default: "text-foreground",
    green:   "text-green-700",
    amber:   "text-amber-700",
    blue:    "text-blue-700",
  };
  return (
    <div className={`rounded-xl border p-4 ${colors[color]}`}>
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className={`text-2xl font-bold ${textColors[color]}`}>{value}</p>
      {sub && <p className="text-xs text-muted-foreground mt-1">{sub}</p>}
    </div>
  );
}

function SettlementBadge({ row }: { row: GatewayTransaction }) {
  if (!row.razorpay_payment_id) {
    return <Badge variant="secondary" className="text-xs bg-gray-100 text-gray-500">No ID</Badge>;
  }
  if (row.settled) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Settled
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600">
      <Clock className="h-3.5 w-3.5" />
      Pending
    </span>
  );
}

function MethodIcon({ method }: { method: string | null }) {
  if (!method) return <Globe className="h-3.5 w-3.5 text-muted-foreground" />;
  if (method === "upi") return <Smartphone className="h-3.5 w-3.5 text-purple-500" />;
  if (method === "card") return <CreditCard className="h-3.5 w-3.5 text-blue-500" />;
  return <Globe className="h-3.5 w-3.5 text-muted-foreground" />;
}

function EntityTypeBadge({ row }: { row: GatewayTransaction }) {
  if (row.manually_linked) {
    const label = row.entity_type === "contract" ? "Contract (linked)"
      : row.entity_type === "booking" ? "Booking (linked)"
      : "Invoice (linked)";
    return <Badge variant="secondary" className="text-[10px] bg-violet-100 text-violet-800">{label}</Badge>;
  }
  if (row.entity_type === "contract") {
    return <Badge variant="secondary" className="text-[10px] bg-emerald-100 text-emerald-800">Contract</Badge>;
  }
  if (row.entity_type === "booking") {
    return <Badge variant="secondary" className="text-[10px] bg-cyan-100 text-cyan-800">Booking</Badge>;
  }
  if (row.entity_type === "billing_statement") {
    return <Badge variant="secondary" className="text-[10px] bg-indigo-100 text-indigo-800">Invoice</Badge>;
  }
  if (row.entity_type === "proposal") {
    return <Badge variant="secondary" className="text-[10px] bg-amber-100 text-amber-800">Proposal</Badge>;
  }
  if (row.entity_type === "deposit_topup") {
    return <Badge variant="secondary" className="text-[10px] bg-teal-100 text-teal-800">Deposit top-up</Badge>;
  }
  if (row.entity_type === "prepaid_purchase") {
    return <Badge variant="secondary" className="text-[10px] bg-pink-100 text-pink-800">Prepaid</Badge>;
  }
  if (row.entity_type === "adhoc_invoice") {
    return <Badge variant="secondary" className="text-[10px] bg-indigo-100 text-indigo-800">Invoice</Badge>;
  }
  return <Badge variant="secondary" className="text-[10px] bg-orange-100 text-orange-700">Not in CRM</Badge>;
}

// ── Link Drawer ───────────────────────────────────────────────────────────────

function LinkDrawer({
  row,
  onClose,
  onSuccess,
}: {
  row: GatewayTransaction;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [query, setQuery]           = useState("");
  const [typeFilter, setTypeFilter] = useState<"all" | "contract" | "booking" | "billing_statement">("all");
  const [results, setResults]       = useState<SearchResult[]>([]);
  const [searching, setSearching]   = useState(false);
  const [selected, setSelected]     = useState<SearchResult | null>(null);
  const [note, setNote]             = useState(row.link_notes ?? "");
  const [saving, setSaving]         = useState(false);
  const [unlinking, setUnlinking]   = useState(false);
  const [logs, setLogs]             = useState<LinkLog[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isLinked = row.manually_linked;

  // Load history
  useEffect(() => {
    if (!row.razorpay_payment_id) return;
    fetch(`/api/finance/gateway-activity/link?payment_id=${row.razorpay_payment_id}`)
      .then(r => r.json())
      .then(d => setLogs(d.logs ?? []));
  }, [row.razorpay_payment_id]);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) { setResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/finance/gateway-activity/search-entity?q=${encodeURIComponent(query)}&type=${typeFilter}`);
        const d = await res.json();
        setResults(d.results ?? []);
      } finally {
        setSearching(false);
      }
    }, 300);
  }, [query, typeFilter]);

  async function handleLink() {
    if (!selected || !row.razorpay_payment_id) return;
    setSaving(true);
    try {
      const res = await fetch("/api/finance/gateway-activity/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          razorpay_payment_id: row.razorpay_payment_id,
          entity_type: selected.entity_type,
          entity_id: selected.entity_id,
          notes: note || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error || "Failed to link");
      } else {
        toast.success("Payment linked successfully");
        onSuccess();
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleUnlink() {
    if (!row.razorpay_payment_id) return;
    setUnlinking(true);
    try {
      const res = await fetch("/api/finance/gateway-activity/link", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ razorpay_payment_id: row.razorpay_payment_id }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error || "Failed to unlink");
      } else {
        toast.success("Payment unlinked");
        onSuccess();
      }
    } finally {
      setUnlinking(false);
    }
  }

  const entityTypeLabel = (t: string) =>
    t === "contract" ? "Contract" : t === "booking" ? "Booking" : "Invoice";

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-background border-l shadow-xl z-50 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <div>
            <h2 className="font-semibold text-base flex items-center gap-2">
              <Link2 className="h-4 w-4 text-violet-600" />
              {isLinked ? "Re-link Payment" : "Link to CRM Record"}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5 font-mono">
              {row.razorpay_payment_id} · {formatCurrency(row.amount)}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Currently linked banner */}
        {isLinked && (
          <div className="mx-4 mt-4 rounded-lg bg-violet-50 border border-violet-200 px-4 py-3 text-sm">
            <p className="font-medium text-violet-800">Currently linked to</p>
            <p className="text-violet-700 mt-0.5">
              {entityTypeLabel(row.entity_type)}: {row.entity_ref ?? row.entity_label}
              {" · "}{row.customer_name}
            </p>
            {row.link_notes && <p className="text-xs text-violet-600 mt-1">Note: {row.link_notes}</p>}
            {row.link_linked_by && (
              <p className="text-xs text-violet-500 mt-0.5">
                Linked by {row.link_linked_by} · {row.link_linked_at ? formatDate(row.link_linked_at) : ""}
              </p>
            )}
          </div>
        )}

        {/* Search */}
        <div className="px-4 pt-4 space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {isLinked ? "Search to re-link" : "Search for a record to link"}
          </p>

          {/* Type filter pills */}
          <div className="flex gap-1.5 flex-wrap">
            {(["all", "contract", "booking", "billing_statement"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTypeFilter(t)}
                className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                  typeFilter === t
                    ? "bg-violet-600 text-white border-violet-600"
                    : "border-border text-muted-foreground hover:border-violet-400"
                }`}
              >
                {t === "all" ? "All" : t === "billing_statement" ? "Invoices" : t === "contract" ? "Contracts" : "Bookings"}
              </button>
            ))}
          </div>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              className="w-full pl-8 pr-3 py-2 text-sm border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-violet-500"
              placeholder="Name, contract #, booking #, invoice #…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            {searching && <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
        </div>

        {/* Results */}
        <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5 mt-1">
          {results.length === 0 && query.length >= 2 && !searching && (
            <p className="text-sm text-center text-muted-foreground py-8">No records found</p>
          )}
          {results.length === 0 && query.length < 2 && (
            <p className="text-xs text-center text-muted-foreground py-6">Type at least 2 characters to search</p>
          )}
          {results.map((r) => (
            <button
              key={`${r.entity_type}-${r.entity_id}`}
              onClick={() => setSelected(r)}
              className={`w-full text-left rounded-lg border px-3 py-2.5 transition-colors ${
                selected?.entity_id === r.entity_id
                  ? "border-violet-500 bg-violet-50"
                  : "border-border hover:border-violet-300 hover:bg-muted/30"
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                  {entityTypeLabel(r.entity_type)}
                </span>
                {r.status && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">{r.status}</span>
                )}
              </div>
              <p className="text-sm font-medium mt-0.5">{r.ref} · {r.customer}</p>
              <p className="text-xs text-muted-foreground">{r.detail}</p>
            </button>
          ))}
        </div>

        {/* Note + actions */}
        <div className="border-t px-4 py-4 space-y-3">
          {selected && (
            <div className="rounded-lg bg-violet-50 border border-violet-200 px-3 py-2 text-xs text-violet-800">
              Linking to: <strong>{selected.ref}</strong> · {selected.customer}
            </div>
          )}
          <textarea
            className="w-full text-sm border rounded-lg px-3 py-2 bg-background focus:outline-none focus:ring-2 focus:ring-violet-500 resize-none"
            placeholder="Add a note (optional) — e.g. advance rent for June"
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex gap-2">
            {isLinked && (
              <button
                onClick={handleUnlink}
                disabled={unlinking}
                className="flex items-center gap-1.5 text-xs px-3 py-2 border border-red-200 text-red-600 rounded-lg hover:bg-red-50 disabled:opacity-50"
              >
                {unlinking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Unlink className="h-3.5 w-3.5" />}
                Unlink
              </button>
            )}
            <button
              onClick={handleLink}
              disabled={!selected || saving}
              className="flex-1 flex items-center justify-center gap-1.5 text-sm px-4 py-2 bg-violet-600 text-white rounded-lg hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
              {isLinked ? "Re-link" : "Link & Save"}
            </button>
          </div>

          {/* History toggle */}
          {logs.length > 0 && (
            <button
              onClick={() => setShowHistory(v => !v)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              <History className="h-3 w-3" />
              {showHistory ? "Hide" : "Show"} history ({logs.length})
            </button>
          )}
          {showHistory && (
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {logs.map((l) => (
                <div key={l.id} className="text-xs border rounded px-2.5 py-1.5 bg-muted/30">
                  <span className={`font-medium ${l.action === "unlinked" ? "text-red-600" : "text-violet-700"}`}>
                    {l.action}
                  </span>
                  {l.new_entity_type && <span className="text-muted-foreground"> → {entityTypeLabel(l.new_entity_type)}</span>}
                  <span className="text-muted-foreground"> · {l.users?.full_name ?? "—"} · {formatDate(l.performed_at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function GatewayActivityPage() {
  const [rows, setRows]             = useState<GatewayTransaction[]>([]);
  const [summary, setSummary]       = useState<Summary | null>(null);
  const [lastSync, setLastSync]     = useState<SyncLog | null>(null);
  const [loading, setLoading]       = useState(false);
  const [syncing, setSyncing]       = useState(false);

  // Filters
  const [fromDate, setFromDate]         = useState(() => {
    const d = new Date(); d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [toDate, setToDate]             = useState(() => new Date().toISOString().slice(0, 10));
  const [entityFilter, setEntityFilter] = useState("");
  const [settledFilter, setSettledFilter] = useState("");
  const [search, setSearch]             = useState("");

  // Settlement detail expansion
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Link drawer
  const [linkRow, setLinkRow] = useState<GatewayTransaction | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        from_date: fromDate,
        to_date:   toDate,
      });
      if (entityFilter)  params.set("entity_type", entityFilter);
      if (settledFilter) params.set("settled",      settledFilter);

      const res = await fetch(`/api/finance/gateway-activity?${params}`);
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        toast.error(json?.error || "Failed to load gateway activity");
        return;
      }
      const json = await res.json();
      setRows(json.data || []);
      setSummary(json.summary || null);
      setLastSync(json.last_sync || null);
      if (json.query_errors?.length) {
        toast.error(`Data query error: ${json.query_errors[0]}`);
      }
    } finally {
      setLoading(false);
    }
  }, [fromDate, toDate, entityFilter, settledFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res  = await fetch("/api/finance/gateway-activity/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ months_back: 2 }) });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error || "Sync failed");
      } else {
        toast.success(json.message);
        await fetchData();
      }
    } catch {
      toast.error("Sync request failed");
    } finally {
      setSyncing(false);
    }
  };

  // Client-side search filter
  const filtered = rows.filter((r) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      r.customer_name.toLowerCase().includes(q) ||
      (r.entity_ref?.toLowerCase().includes(q) ?? false) ||
      (r.razorpay_payment_id?.toLowerCase().includes(q) ?? false) ||
      (r.settlement_utr?.toLowerCase().includes(q) ?? false)
    );
  });

  // Group by settlement date; rows without settled_at go into "pending"
  const groupedRows: { dateKey: string; label: string; rows: GatewayTransaction[] }[] = (() => {
    const dateMap = new Map<string, GatewayTransaction[]>();
    const pending: GatewayTransaction[] = [];
    for (const r of filtered) {
      if (r.settled && r.settled_at) {
        const key = r.settled_at.slice(0, 10);
        if (!dateMap.has(key)) dateMap.set(key, []);
        dateMap.get(key)!.push(r);
      } else {
        pending.push(r);
      }
    }
    const sorted = Array.from(dateMap.entries())
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([key, rows]) => ({
        dateKey: key,
        label: formatDate(key),
        rows,
      }));
    if (pending.length > 0) {
      sorted.push({ dateKey: "pending", label: "Pending Settlement", rows: pending });
    }
    return sorted;
  })();

  const lastSyncText = lastSync
    ? `Last synced ${formatDate(lastSync.synced_at)}${lastSync.error_message ? " (with errors)" : ""}`
    : "Never synced";

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
      <PageBreadcrumb resetTo={{ label: "Gateway Activity" }} />
      {linkRow && (
        <LinkDrawer
          row={linkRow}
          onClose={() => setLinkRow(null)}
          onSuccess={() => { setLinkRow(null); fetchData(); }}
        />
      )}
      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-bold tracking-tight">Gateway Activity</h1>
            <GuideReopenButton guideKey="gateway-activity" label="How it works" />
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            Razorpay transactions captured — cash flow expected in bank
          </p>
        </div>
        <div className="flex items-center gap-2">
          <p className="text-xs text-muted-foreground hidden sm:block">{lastSyncText}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
            className="gap-1.5"
          >
            {syncing
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Syncing…</>
              : <><RefreshCw className="h-3.5 w-3.5" />Sync Settlement Status</>
            }
          </Button>
        </div>
      </div>

      <FinanceGuideCard
        guideKey="gateway-activity"
        accentColor="purple"
        title="Welcome to Gateway Activity 👋"
        subtitle="This is your live feed of every Razorpay payment — bookings, invoices, and anything paid via the gateway. Use it to reconcile what Razorpay collected vs. what landed in your bank."
        steps={[
          {
            number: 1,
            title: "Sync first",
            description: "Click 'Sync Settlement Status' in the top-right to pull the latest data from Razorpay. Do this before reconciling.",
          },
          {
            number: 2,
            title: "Read the status columns",
            description: "'Captured' means Razorpay has the money. 'Settled' means it's been transferred to your bank. 'Pending' means it's in transit (usually T+2 business days).",
          },
          {
            number: 3,
            title: "Find your transaction",
            description: "Use the date range, payment method, or settlement filter to narrow down. The search box also matches payment IDs, UTRs, and customer names.",
          },
          {
            number: 4,
            title: "Match to your bank statement",
            description: "The UTR column shows the exact reference that appears in your bank credit line. Copy it to verify a deposit.",
          },
          {
            number: 5,
            title: "'Not in CRM' transactions",
            description: "Orange badges mean the payment was made via Razorpay but not through CRM flow (no booking or invoice linked). Flag these for review — they may be direct link payments.",
          },
        ]}
        tip="The sync auto-extends backwards — if you sync with 3 months selected, it always covers from the oldest transaction ever synced, so you'll never have gaps."
      />

      {/* ── Settlement info callout ── */}
      <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm text-blue-800 flex gap-2.5">
        <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
        <p>
          <strong>How settlement works:</strong> Razorpay captures payments immediately (status shown in table).
          Funds are typically settled to your bank account in <strong>T+2 business days</strong>.
          Click <em>Sync Settlement Status</em> to pull the latest UTR numbers from Razorpay — the UTR appears verbatim in your bank credit line, enabling direct reconciliation.
        </p>
      </div>

      {/* ── Summary cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard
          label="Total Captured"
          value={formatCurrency(summary?.total_captured ?? 0)}
          sub={`${summary?.count ?? 0} transactions`}
          color="default"
        />
        <SummaryCard
          label="Settled to Bank"
          value={formatCurrency(summary?.total_settled ?? 0)}
          sub="Confirmed by UTR"
          color="green"
        />
        <SummaryCard
          label="Pending Settlement"
          value={formatCurrency(summary?.total_pending ?? 0)}
          sub="In transit / not yet synced"
          color="amber"
        />
        <SummaryCard
          label="Razorpay Fees"
          value={formatCurrency(summary?.total_fees ?? 0)}
          sub="Deducted before settlement"
          color="blue"
        />
      </div>

      {/* ── Filters ── */}
      <div className="flex flex-wrap gap-2 items-end">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Filter:</span>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-muted-foreground">From</label>
          <Input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-36 h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-muted-foreground">To</label>
          <Input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-36 h-8 text-xs"
          />
        </div>
        <Select value={entityFilter || "all"} onValueChange={(v) => setEntityFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-40 text-xs">
            <SelectValue placeholder="Entity type" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="booking">Bookings</SelectItem>
            <SelectItem value="billing_statement">Invoices</SelectItem>
            <SelectItem value="proposal">Proposals</SelectItem>
            <SelectItem value="deposit_topup">Deposit top-ups</SelectItem>
            <SelectItem value="prepaid_purchase">Prepaid</SelectItem>
            <SelectItem value="adhoc_invoice">Ad-hoc invoices</SelectItem>
            <SelectItem value="unmatched">Not in CRM</SelectItem>
          </SelectContent>
        </Select>
        <Select value={settledFilter || "all"} onValueChange={(v) => setSettledFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-44 text-xs">
            <SelectValue placeholder="Settlement" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All settlement statuses</SelectItem>
            <SelectItem value="true">Settled</SelectItem>
            <SelectItem value="false">Pending settlement</SelectItem>
          </SelectContent>
        </Select>
        <div className="relative ml-auto">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search customer, ref, UTR…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 w-56 text-xs"
          />
        </div>
      </div>

      {/* ── Table ── */}
      {loading ? (
        <div className="flex justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <Banknote className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="font-medium">No gateway transactions found</p>
          <p className="text-sm mt-1">Try adjusting the date range or filters</p>
        </div>
      ) : (
        <div className="rounded-xl border overflow-hidden">
          {/* Desktop table */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/40 border-b text-xs text-muted-foreground uppercase tracking-wide">
                  <th className="text-left px-4 py-2.5">Date</th>
                  <th className="text-left px-4 py-2.5">Customer</th>
                  <th className="text-left px-4 py-2.5">Source</th>
                  <th className="text-right px-4 py-2.5">Amount</th>
                  <th className="text-right px-4 py-2.5">Fees</th>
                  <th className="text-left px-4 py-2.5">Method</th>
                  <th className="text-left px-4 py-2.5">Settlement</th>
                  <th className="text-left px-4 py-2.5">UTR / Pay ID</th>
                  <th className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {groupedRows.map((group) => (
                  <Fragment key={group.dateKey}>
                    {/* Settlement date group header */}
                    <tr className="bg-muted/60 border-y">
                      <td colSpan={9} className="px-4 py-2">
                        <div className="flex items-center justify-between">
                          <span className={`text-xs font-semibold uppercase tracking-wide ${group.dateKey === "pending" ? "text-amber-700" : "text-green-700"}`}>
                            {group.dateKey === "pending"
                              ? <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{group.label}</span>
                              : <span className="flex items-center gap-1"><ArrowDownToLine className="h-3.5 w-3.5" />Settled {group.label}</span>
                            }
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {group.rows.length} txn · {formatCurrency(group.rows.reduce((s, r) => s + r.amount, 0))}
                          </span>
                        </div>
                      </td>
                    </tr>
                    {group.rows.map((row) => {
                  const isExpanded = expandedId === row.id;
                  return (
                    <Fragment key={row.id}>
                      <tr
                        className="hover:bg-muted/30 transition-colors cursor-pointer"
                        onClick={() => setExpandedId(isExpanded ? null : row.id)}
                      >
                        <td className="px-4 py-3 text-xs text-muted-foreground whitespace-nowrap">
                          {formatDate(row.created_at)}
                        </td>
                        <td className="px-4 py-3 font-medium max-w-[160px] truncate">
                          {row.customer_name}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <EntityTypeBadge row={row} />
                            {row.entity_href ? (
                              <Link
                                href={row.entity_href}
                                className="text-xs text-primary hover:underline flex items-center gap-0.5"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {row.entity_ref ?? row.entity_label}
                                <ExternalLink className="h-2.5 w-2.5" />
                              </Link>
                            ) : (
                              <span className="text-xs text-muted-foreground">{row.entity_ref ?? row.entity_label}</span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold">
                          {formatCurrency(row.amount)}
                        </td>
                        <td className="px-4 py-3 text-right text-xs text-muted-foreground">
                          {row.fee != null ? formatCurrency(row.fee) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <span className="flex items-center gap-1 capitalize text-xs">
                            <MethodIcon method={row.payment_method} />
                            {row.payment_method ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-3">
                          <SettlementBadge row={row} />
                          {row.settled && row.settled_at && (
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {formatDate(row.settled_at)}
                            </p>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          {row.settlement_utr ? (
                            <div>
                              <p className="text-xs font-mono font-medium text-green-700">{row.settlement_utr}</p>
                              {row.razorpay_payment_id && (
                                <p className="text-[10px] font-mono text-muted-foreground">{row.razorpay_payment_id}</p>
                              )}
                            </div>
                          ) : row.razorpay_payment_id ? (
                            <p className="text-xs font-mono text-muted-foreground">{row.razorpay_payment_id}</p>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <ChevronDown
                            className={`h-4 w-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-180" : ""}`}
                          />
                        </td>
                      </tr>

                      {/* Expanded detail row */}
                      {isExpanded && (
                        <tr className="bg-muted/20">
                          <td colSpan={9} className="px-6 py-4">
                            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
                              <div>
                                <p className="text-muted-foreground uppercase tracking-wider mb-1">Razorpay Payment ID</p>
                                <p className="font-mono">{row.razorpay_payment_id ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground uppercase tracking-wider mb-1">Settlement ID</p>
                                <p className="font-mono">{row.settlement_id ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground uppercase tracking-wider mb-1">Settlement UTR</p>
                                <p className="font-mono font-medium text-green-700">{row.settlement_utr ?? "Not yet settled"}</p>
                                <p className="text-muted-foreground mt-0.5">Match this in your bank statement</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground uppercase tracking-wider mb-1">Fees Breakdown</p>
                                <p>Gateway fee: {row.fee != null ? formatCurrency(row.fee) : "—"}</p>
                                <p>GST on fee: {row.tax != null ? formatCurrency(row.tax) : "—"}</p>
                                {row.fee != null && (
                                  <p className="font-medium mt-0.5">
                                    Net to bank: {formatCurrency(row.amount - (row.fee ?? 0))}
                                  </p>
                                )}
                              </div>
                              <div>
                                <p className="text-muted-foreground uppercase tracking-wider mb-1">Payment method</p>
                                <p className="capitalize">{row.payment_method ?? "—"}</p>
                              </div>
                              <div>
                                <p className="text-muted-foreground uppercase tracking-wider mb-1">Captured at</p>
                                <p>{formatDate(row.created_at)}</p>
                              </div>
                              {row.settled_at && (
                                <div>
                                  <p className="text-muted-foreground uppercase tracking-wider mb-1">Settled at</p>
                                  <p>{formatDate(row.settled_at)}</p>
                                </div>
                              )}
                              {row.entity_href && (
                                <div>
                                  <p className="text-muted-foreground uppercase tracking-wider mb-1">Source record</p>
                                  <Link
                                    href={row.entity_href}
                                    className="text-primary hover:underline flex items-center gap-1"
                                  >
                                    {row.entity_label}
                                    <ExternalLink className="h-3 w-3" />
                                  </Link>
                                </div>
                              )}
                              {row.manually_linked && row.link_notes && (
                                <div>
                                  <p className="text-muted-foreground uppercase tracking-wider mb-1">Link note</p>
                                  <p className="text-violet-700">{row.link_notes}</p>
                                </div>
                              )}
                              {/* Link / Re-link action */}
                              {(!row.in_crm) && (
                                <div className="col-span-2 sm:col-span-4 pt-1">
                                  <button
                                    onClick={(e) => { e.stopPropagation(); setLinkRow(row); }}
                                    className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border font-medium transition-colors ${
                                      row.manually_linked
                                        ? "border-violet-300 text-violet-700 hover:bg-violet-50"
                                        : "border-orange-300 text-orange-700 hover:bg-orange-50"
                                    }`}
                                  >
                                    <Link2 className="h-3.5 w-3.5" />
                                    {row.manually_linked ? "Re-link or Unlink" : "Link to CRM record"}
                                  </button>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {/* Footer row with totals */}
          <div className="border-t bg-muted/30 px-4 py-3 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{filtered.length} transactions shown</span>
            <div className="flex items-center gap-6">
              <span className="text-muted-foreground text-xs">
                Total fees: <span className="font-medium text-foreground">{formatCurrency(filtered.reduce((s, r) => s + (r.fee ?? 0), 0))}</span>
              </span>
              <Separator orientation="vertical" className="h-4" />
              <span className="text-xs">
                Total captured: <span className="font-bold">{formatCurrency(filtered.reduce((s, r) => s + r.amount, 0))}</span>
              </span>
              <Separator orientation="vertical" className="h-4" />
              <span className="text-xs flex items-center gap-1">
                <ArrowDownToLine className="h-3.5 w-3.5 text-green-600" />
                Net to bank: <span className="font-bold text-green-700">
                  {formatCurrency(filtered.reduce((s, r) => s + r.amount - (r.fee ?? 0), 0))}
                </span>
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Legend ── */}
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5 text-green-600" /> Settled — funds received in bank account with UTR</span>
        <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5 text-amber-500" /> Pending — captured by Razorpay, settlement in 1–2 business days</span>
        <span className="flex items-center gap-1"><RefreshCw className="h-3.5 w-3.5" /> Sync to pull latest UTR numbers from Razorpay</span>
      </div>
    </div>
  );
}

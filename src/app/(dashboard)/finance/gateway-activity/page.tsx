"use client";

import { useState, useEffect, useCallback, Fragment } from "react";
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

// ── Types ────────────────────────────────────────────────────────────────────

type EntityType = "booking" | "billing_statement" | "unmatched";

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
  if (row.entity_type === "booking") {
    return <Badge variant="secondary" className="text-[10px] bg-cyan-100 text-cyan-800">Booking</Badge>;
  }
  if (row.entity_type === "billing_statement") {
    return <Badge variant="secondary" className="text-[10px] bg-indigo-100 text-indigo-800">Invoice</Badge>;
  }
  return <Badge variant="secondary" className="text-[10px] bg-orange-100 text-orange-700">Not in CRM</Badge>;
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

  const lastSyncText = lastSync
    ? `Last synced ${formatDate(lastSync.synced_at)}${lastSync.error_message ? " (with errors)" : ""}`
    : "Never synced";

  return (
    <div className="p-6 space-y-6 max-w-[1400px]">
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
                {filtered.map((row) => {
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
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
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

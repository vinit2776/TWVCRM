"use client";

/**
 * Tally Sync Control — admin page.
 *
 * One screen to manage the CRM ↔ Tally sync:
 *   - Live bridge + Tally connection status
 *   - Company guard: lock / update / unlock the allowed company (prevents
 *     posting invoices into the wrong company's books)
 *   - Pause / resume the whole sync
 *   - Ledger mapping (which Tally ledgers receive each charge type)
 *   - Audit log: every job that passed through, with status, invoice no, IRN,
 *     and a retry button for failures
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  CheckCircle2, AlertTriangle, WifiOff, RefreshCw, Lock, Unlock,
  ChevronLeft, ChevronRight, Clock, Pause, Play,
} from "lucide-react";
import { formatDateTime } from "@/lib/utils";
import { toast } from "sonner";

interface ControlState {
  sync_enabled: boolean;
  paused_reason: string;
  locked_company: string;
  detected_company: string;
  company_match: boolean;
  company_locked: boolean;
  gstin: string;
  irn_alarm_hours: string;
  ledgers: Record<string, string>;
  receipt: {
    account: string;
    voucher_series: string;
    bill_by_bill: boolean;
    account_is_bank: boolean;
    transaction_type: string;
    transfer_mode: string;
  };
  bridge: {
    online: boolean;
    version: string | null;
    tally_connected: boolean;
    last_seen_at: string | null;
    last_sync_at: string | null;
    last_error: string | null;
    pending_count: number;
    failed_count: number;
  };
}

interface Job {
  id: string;
  job_type: string;
  status: string;
  tally_invoice_number: string | null;
  tally_irn: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
  created_at: string;
  completed_at: string | null;
}

const STATUS_BADGE: Record<string, string> = {
  pending:   "bg-gray-100 text-gray-700",
  claimed:   "bg-blue-100 text-blue-700",
  posted:    "bg-amber-100 text-amber-700",
  completed: "bg-green-100 text-green-700",
  failed:    "bg-red-100 text-red-700",
};

const LEDGER_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "rent_income",    label: "Rent income ledger",  placeholder: "e.g. Space Rent Income" },
  { key: "usage_income",   label: "Usage income ledger", placeholder: "e.g. Usage Income" },
  { key: "cgst",           label: "Output CGST ledger",  placeholder: "e.g. Output CGST" },
  { key: "sgst",           label: "Output SGST ledger",  placeholder: "e.g. Output SGST" },
  { key: "igst",           label: "Output IGST ledger",  placeholder: "e.g. Output IGST" },
  { key: "round_off",      label: "Round-off ledger",    placeholder: "e.g. Round Off" },
  { key: "voucher_series", label: "Sales voucher series",placeholder: "e.g. Sales" },
  { key: "party_suffix",   label: "Party name suffix",   placeholder: "(optional)" },
];

// Receipt reverse-sync settings (CRM payment → Tally Receipt voucher).
const RECEIPT_TEXT_FIELDS: Array<{ key: string; label: string; placeholder: string }> = [
  { key: "account",          label: "Receipt account ledger", placeholder: "e.g. ICICI BANK A/C NO.000905000140" },
  { key: "voucher_series",   label: "Receipt voucher type",   placeholder: "Receipt" },
  { key: "transaction_type", label: "Bank transaction type",  placeholder: "e-Fund Transfer" },
  { key: "transfer_mode",    label: "Bank transfer mode",     placeholder: "NEFT" },
];

export default function TallySyncPage() {
  const [state, setState] = useState<ControlState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [ledgerDraft, setLedgerDraft] = useState<Record<string, string>>({});
  const [receiptDraft, setReceiptDraft] = useState<Record<string, string>>({});
  const [pauseReason, setPauseReason] = useState("");

  // Audit log
  const [jobs, setJobs] = useState<Job[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/tally/control");
      if (!res.ok) { toast.error("Failed to load (admin only)"); return; }
      const data = await res.json() as ControlState;
      setState(data);
      setLedgerDraft(data.ledgers);
      setReceiptDraft({
        account:          data.receipt.account,
        voucher_series:   data.receipt.voucher_series,
        transaction_type: data.receipt.transaction_type,
        transfer_mode:    data.receipt.transfer_mode,
        bill_by_bill:     String(data.receipt.bill_by_bill),
        account_is_bank:  String(data.receipt.account_is_bank),
      });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchJobs = useCallback(async () => {
    const params = new URLSearchParams({ page: String(page), limit: "20" });
    if (statusFilter) params.set("status", statusFilter);
    const res = await fetch(`/api/tally/jobs?${params}`);
    if (res.ok) {
      const json = await res.json();
      setJobs(json.data ?? []);
      setTotalPages(json.pagination?.totalPages ?? 1);
    }
  }, [page, statusFilter]);

  useEffect(() => { void fetchState(); }, [fetchState]);
  useEffect(() => { void fetchJobs(); }, [fetchJobs]);
  // Refresh status every 30s
  useEffect(() => {
    const t = setInterval(() => void fetchState(), 30_000);
    return () => clearInterval(t);
  }, [fetchState]);

  async function patch(body: Record<string, unknown>, successMsg: string) {
    setBusy(true);
    try {
      const res = await fetch("/api/tally/control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) { toast.success(successMsg); await fetchState(); }
      else { const e = await res.json(); toast.error(e.error ?? "Failed"); }
    } finally { setBusy(false); }
  }

  async function retryJob(id: string) {
    const res = await fetch("/api/tally/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "retry", job_id: id }),
    });
    if (res.ok) { toast.success("Job re-queued"); await fetchJobs(); }
    else { const e = await res.json(); toast.error(e.error ?? "Retry failed"); }
  }

  if (loading) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!state)  return <div className="p-8 text-muted-foreground">Could not load. Admin access required.</div>;

  const b = state.bridge;
  const bridgeStatus = !b.online ? "offline" : (!b.tally_connected || b.failed_count > 0 || !state.company_match) ? "degraded" : "healthy";

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Tally Sync Control</h1>
          <p className="text-sm text-muted-foreground">Manage the CRM ↔ Tally invoice sync, company guard, and audit log.</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => { void fetchState(); void fetchJobs(); }}>
          <RefreshCw className="h-4 w-4 mr-1" /> Refresh
        </Button>
      </div>

      {/* ── Status + master switch ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span className="flex items-center gap-2">
              {bridgeStatus === "healthy" && <CheckCircle2 className="h-5 w-5 text-green-600" />}
              {bridgeStatus === "degraded" && <AlertTriangle className="h-5 w-5 text-yellow-600" />}
              {bridgeStatus === "offline" && <WifiOff className="h-5 w-5 text-red-600" />}
              Bridge status
            </span>
            <Badge variant={state.sync_enabled ? "default" : "secondary"}>
              {state.sync_enabled ? "Active" : "Paused"}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
            <StatBox label="Bridge" value={b.online ? "Online" : "Offline"} ok={b.online} />
            <StatBox label="Tally" value={b.tally_connected ? "Connected" : "Disconnected"} ok={b.tally_connected} />
            <StatBox label="Pending" value={String(b.pending_count)} ok={b.pending_count === 0} />
            <StatBox label="Failed" value={String(b.failed_count)} ok={b.failed_count === 0} />
          </div>
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            {b.version && <span>Version v{b.version}</span>}
            {b.last_seen_at && <span className="flex items-center gap-1"><Clock className="h-3 w-3" /> Last seen {formatDateTime(b.last_seen_at)}</span>}
            {b.last_sync_at && <span>Last sync {formatDateTime(b.last_sync_at)}</span>}
          </div>
          {b.last_error && (
            <div className="text-xs text-red-600 bg-red-50 rounded p-2">Last error: {b.last_error}</div>
          )}

          {/* Pause / resume */}
          <div className="flex items-center justify-between border-t pt-4">
            <div className="flex items-center gap-3">
              <Switch
                checked={state.sync_enabled}
                disabled={busy}
                onCheckedChange={(on) => {
                  if (on) void patch({ action: "resume" }, "Sync resumed");
                  else void patch({ action: "pause", reason: pauseReason }, "Sync paused");
                }}
              />
              <div>
                <div className="text-sm font-medium flex items-center gap-1">
                  {state.sync_enabled ? <><Play className="h-3.5 w-3.5" /> Sync active</> : <><Pause className="h-3.5 w-3.5" /> Sync paused</>}
                </div>
                <div className="text-xs text-muted-foreground">
                  {state.sync_enabled ? "Finalized invoices flow to Tally automatically." : (state.paused_reason || "Invoices queue but are not sent until resumed.")}
                </div>
              </div>
            </div>
            {!state.sync_enabled && (
              <Input
                placeholder="Pause reason (optional)"
                className="w-56 text-xs"
                value={pauseReason}
                onChange={(e) => setPauseReason(e.target.value)}
                onBlur={() => state.paused_reason !== pauseReason && void patch({ action: "pause", reason: pauseReason }, "Reason updated")}
              />
            )}
          </div>
        </CardContent>
      </Card>

      {/* ── Company guard ──────────────────────────────────────────────────── */}
      <Card className={!state.company_match ? "border-red-300" : ""}>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4" /> Company guard
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!state.company_match && (
            <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 rounded p-3">
              <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
              <span>
                <strong>Sync blocked.</strong> Locked to <strong>{state.locked_company}</strong> but
                Tally currently has <strong>{state.detected_company}</strong> open. No invoices will
                post until the correct company is loaded in Tally, or you update the lock below.
              </span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 text-sm">
            <div>
              <div className="text-muted-foreground text-xs">Currently open in Tally</div>
              <div className="font-medium">{state.detected_company || <span className="text-muted-foreground">— not detected —</span>}</div>
            </div>
            <div>
              <div className="text-muted-foreground text-xs">Locked (allowed) company</div>
              <div className="font-medium flex items-center gap-2">
                {state.locked_company || <span className="text-muted-foreground">— not locked —</span>}
                {state.company_locked && state.company_match && <CheckCircle2 className="h-4 w-4 text-green-600" />}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2 border-t pt-3">
            {!state.company_locked && state.detected_company && (
              <Button size="sm" disabled={busy}
                onClick={() => void patch({ action: "lock_company", company: state.detected_company }, `Locked to ${state.detected_company}`)}>
                <Lock className="h-4 w-4 mr-1" /> Lock to “{state.detected_company}”
              </Button>
            )}
            {state.company_locked && state.detected_company && !state.company_match && (
              <Button size="sm" variant="outline" disabled={busy}
                onClick={() => void patch({ action: "update_company", company: state.detected_company }, `Lock updated to ${state.detected_company}`)}>
                Update lock to “{state.detected_company}”
              </Button>
            )}
            {state.company_locked && (
              <Button size="sm" variant="ghost" disabled={busy}
                onClick={() => void patch({ action: "unlock_company" }, "Company unlocked")}>
                <Unlock className="h-4 w-4 mr-1" /> Unlock
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            When a company is locked, invoices only post if Tally has that exact company open.
            If your Tally company name ever changes, update the lock here — no need to touch the Tally server.
          </p>
        </CardContent>
      </Card>

      {/* ── Ledger mapping ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Ledger mapping</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            The exact Tally ledger names that receive each part of an invoice. Must match the ledger names in Tally exactly.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {LEDGER_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label className="text-xs">{f.label}</Label>
                <Input
                  value={ledgerDraft[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setLedgerDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <Button size="sm" disabled={busy}
            onClick={() => void patch({ action: "update_ledgers", ledgers: ledgerDraft }, "Ledger mapping saved")}>
            Save ledger mapping
          </Button>
        </CardContent>
      </Card>

      {/* ── Receipt reverse-sync (CRM payment → Tally Receipt) ─────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Receipt sync (payments → Tally)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            When a payment is recorded against a Tally-issued invoice, the bridge posts a Receipt voucher in Tally.
            The <b>receipt account ledger</b> is required — use the exact Tally bank/cash ledger that receives customer payments.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {RECEIPT_TEXT_FIELDS.map((f) => (
              <div key={f.key} className="space-y-1">
                <Label className="text-xs">{f.label}</Label>
                <Input
                  value={receiptDraft[f.key] ?? ""}
                  placeholder={f.placeholder}
                  onChange={(e) => setReceiptDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
            <div className="space-y-1">
              <Label className="text-xs">Knock off the invoice (bill-by-bill)</Label>
              <select className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                value={receiptDraft["bill_by_bill"] ?? "true"}
                onChange={(e) => setReceiptDraft((d) => ({ ...d, bill_by_bill: e.target.value }))}>
                <option value="true">Yes — Agst Ref to the invoice</option>
                <option value="false">No — on-account receipt</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Receipt account is a bank</Label>
              <select className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                value={receiptDraft["account_is_bank"] ?? "true"}
                onChange={(e) => setReceiptDraft((d) => ({ ...d, account_is_bank: e.target.value }))}>
                <option value="true">Yes — add bank allocation</option>
                <option value="false">No — cash (no bank allocation)</option>
              </select>
            </div>
          </div>
          <Button size="sm" disabled={busy}
            onClick={() => void patch({ action: "update_receipt", receipt: receiptDraft }, "Receipt settings saved")}>
            Save receipt settings
          </Button>
        </CardContent>
      </Card>

      {/* ── Audit log ──────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center justify-between">
            <span>Audit log</span>
            <div className="flex gap-1">
              {["", "completed", "failed", "pending"].map((s) => (
                <Button key={s || "all"} size="sm" variant={statusFilter === s ? "default" : "outline"}
                  className="h-7 text-xs" onClick={() => { setStatusFilter(s); setPage(1); }}>
                  {s === "" ? "All" : s}
                </Button>
              ))}
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Invoice #</TableHead>
                <TableHead>IRN</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Completed</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {jobs.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No jobs yet</TableCell></TableRow>
              )}
              {jobs.map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <Badge className={STATUS_BADGE[j.status] ?? ""}>{j.status}</Badge>
                    {j.status === "failed" && j.last_error && (
                      <div className="text-xs text-red-600 mt-1 max-w-xs truncate" title={j.last_error}>{j.last_error}</div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">{j.tally_invoice_number ?? "—"}</TableCell>
                  <TableCell className="font-mono text-xs max-w-[120px] truncate" title={j.tally_irn ?? ""}>{j.tally_irn ?? "—"}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(j.created_at)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{j.completed_at ? formatDateTime(j.completed_at) : "—"}</TableCell>
                  <TableCell>
                    {j.status === "failed" && (
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void retryJob(j.id)}>
                        <RefreshCw className="h-3 w-3 mr-1" /> Retry
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <div className="flex items-center justify-end gap-2 mt-3">
            <Button size="sm" variant="outline" className="h-7" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground">Page {page} of {totalPages}</span>
            <Button size="sm" variant="outline" className="h-7" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatBox({ label, value, ok }: { label: string; value: string; ok: boolean }) {
  return (
    <div className="rounded border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-lg font-semibold ${ok ? "text-foreground" : "text-red-600"}`}>{value}</div>
    </div>
  );
}

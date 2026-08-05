"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import {
  Upload, Loader2, ExternalLink, RotateCcw, CheckCircle2, ShieldAlert,
  Search, ChevronDown, ChevronRight, Link2, Banknote, FileWarning,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatDate, formatCurrency } from "@/lib/utils";
import { DEPOSIT_TOPUP_CATEGORY_LABELS, type DepositInboxRow } from "@/types";

interface Props {
  currentUserRole: string;
  /** Fired whenever the open count changes, so the parent tab badge stays in sync. */
  onOpenCountChange?: (count: number) => void;
}

/** Legacy proposals sometimes have deposit_payment_status='paid' with no amount ever recorded — never show ₹0. */
function amountLabel(amount: number | null) {
  return amount == null ? "amount not on file" : formatCurrency(amount);
}

export function DepositAccountingInbox({ currentUserRole, onOpenCountChange }: Props) {
  const [subTab, setSubTab] = useState<"open" | "closed">("open");
  const [rows, setRows] = useState<DepositInboxRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [uploadTarget, setUploadTarget] = useState<DepositInboxRow | null>(null);
  const [reopenTarget, setReopenTarget] = useState<DepositInboxRow | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedSearch(search), 250);
    return () => clearTimeout(handle);
  }, [search]);

  const load = useCallback(async (tab: "open" | "closed", q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/accounting/inbox/deposits?tab=${tab}&q=${encodeURIComponent(q)}`);
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setRows(data.rows);
      if (typeof data.open_count === "number") onOpenCountChange?.(data.open_count);
    } catch {
      toast.error("Could not load the deposits inbox");
    } finally {
      setLoading(false);
    }
  }, [onOpenCountChange]);

  useEffect(() => { load(subTab, debouncedSearch); }, [subTab, debouncedSearch, load]);

  const isAdmin = currentUserRole === "admin";

  return (
    <div>
      <div className="flex items-center gap-2 mb-4 flex-wrap">
        <Button
          size="sm"
          variant={subTab === "open" ? "default" : "outline"}
          onClick={() => setSubTab("open")}
        >
          Pending
        </Button>
        <Button
          size="sm"
          variant={subTab === "closed" ? "default" : "outline"}
          onClick={() => setSubTab("closed")}
        >
          Accounted
        </Button>
        <div className="relative ml-auto min-w-[240px] flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customer, contract #, proposal #, reference…"
            className="pl-8 h-9"
          />
        </div>
      </div>

      {loading && rows === null ? (
        <p className="text-sm text-muted-foreground py-8 text-center">Loading…</p>
      ) : !rows || rows.length === 0 ? (
        <div className="text-center py-12 border rounded-lg border-dashed">
          <CheckCircle2 className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">
            {subTab === "open" ? "No deposits waiting to be accounted." : "Nothing accounted yet."}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => {
            const key = `${row.kind}-${row.id}`;
            const isOpen = expanded === key;
            return (
              <div key={key} className="rounded-lg border">
                <div className="flex items-center justify-between gap-4 p-3">
                  <button
                    className="min-w-0 flex items-start gap-2 text-left"
                    onClick={() => setExpanded(isOpen ? null : key)}
                    aria-expanded={isOpen}
                  >
                    {isOpen
                      ? <ChevronDown className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />
                      : <ChevronRight className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" />}
                    <span className="min-w-0">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm truncate">{row.party_name}</span>
                        <Badge
                          variant="outline"
                          className={row.kind === "deposit"
                            ? "text-xs border-violet-300 bg-violet-50 text-violet-700"
                            : "text-xs border-purple-300 bg-purple-50 text-purple-700"}
                        >
                          {row.kind === "deposit" ? "Security deposit" : "Top-up"}
                        </Badge>
                        {row.category && (
                          <Badge variant="outline" className="text-xs">
                            {DEPOSIT_TOPUP_CATEGORY_LABELS[row.category]}
                          </Badge>
                        )}
                        {row.collection_method && (
                          <Badge variant="outline" className="text-xs gap-1">
                            {row.collection_method === "razorpay"
                              ? <><Link2 className="h-3 w-3" /> Razorpay</>
                              : <><Banknote className="h-3 w-3" /> Manual</>}
                          </Badge>
                        )}
                      </span>
                      <span className="block text-xs text-muted-foreground mt-0.5">
                        {row.contract_number || row.proposal_number || "—"}
                        {row.payment_reference ? ` · Ref: ${row.payment_reference}` : ""}
                        {" · "}{row.paid_at ? formatDate(row.paid_at) : (
                          <span className="text-amber-600">date not on file</span>
                        )}
                      </span>
                      {row.internal_note && (
                        <span className="block text-xs text-muted-foreground mt-0.5 italic truncate" title={row.internal_note}>
                          {row.internal_note}
                        </span>
                      )}
                      {subTab === "closed" && row.accounted_at && (
                        <span className="block text-[11px] text-green-700 mt-0.5">
                          Accounted by {row.accounted_by_name || "—"} on {formatDate(row.accounted_at)}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-right">
                      <span className={row.amount == null ? "block text-xs text-amber-600 italic" : "block font-semibold text-sm"}>
                        {amountLabel(row.amount)}
                      </span>
                      {row.amount == null && row.expected_amount != null && (
                        <span className="block text-[11px] text-muted-foreground">
                          expected {formatCurrency(row.expected_amount)}
                        </span>
                      )}
                    </span>
                    {subTab === "open" ? (
                      <Button size="sm" variant="outline" className="gap-1.5 h-8" onClick={() => setUploadTarget(row)}>
                        <Upload className="h-3.5 w-3.5" /> Upload Receipt
                      </Button>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        {row.proof_path && (
                          <Button size="sm" variant="ghost" className="h-8 gap-1" asChild>
                            <a href={row.proof_path} target="_blank" rel="noopener noreferrer">
                              <ExternalLink className="h-3.5 w-3.5" /> Receipt
                            </a>
                          </Button>
                        )}
                        {isAdmin && (
                          <Button
                            size="sm" variant="ghost"
                            className="h-8 gap-1 text-amber-700 hover:text-amber-800"
                            onClick={() => setReopenTarget(row)}
                          >
                            <RotateCcw className="h-3.5 w-3.5" /> Reopen
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {isOpen && <VerificationPanel row={row} />}
              </div>
            );
          })}
        </div>
      )}

      {uploadTarget && (
        <UploadReceiptDialog
          row={uploadTarget}
          onClose={() => setUploadTarget(null)}
          onDone={() => { setUploadTarget(null); load(subTab, debouncedSearch); }}
        />
      )}
      {reopenTarget && (
        <ReopenDialog
          row={reopenTarget}
          onClose={() => setReopenTarget(null)}
          onDone={() => { setReopenTarget(null); load(subTab, debouncedSearch); }}
        />
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-xs mt-0.5 break-all">{value}</p>
    </div>
  );
}

/**
 * Everything accounts needs to verify the money actually arrived before
 * booking it — the customer's own payment proof for manual collections, or
 * the Razorpay identifiers for link collections.
 */
function VerificationPanel({ row }: { row: DepositInboxRow }) {
  const notOnFile = <span className="text-amber-600 italic">not on file</span>;

  return (
    <div className="border-t bg-muted/30 px-3 py-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Field label="Amount received" value={row.amount == null ? notOnFile : formatCurrency(row.amount)} />
        {row.expected_amount != null && (
          <Field label="Deposit required" value={formatCurrency(row.expected_amount)} />
        )}
        <Field label="Payment date" value={row.paid_at ? formatDate(row.paid_at) : notOnFile} />
        <Field label="Mode" value={row.payment_medium || notOnFile} />
        <Field label="Reference / UTR" value={row.payment_reference || notOnFile} />
        {row.contract_number && <Field label="Contract" value={row.contract_number} />}
        {row.proposal_number && <Field label="Proposal" value={row.proposal_number} />}
      </div>

      {row.collection_method === "razorpay" && (
        <div className="mt-3 rounded-md border border-blue-200 bg-blue-50 p-2.5">
          <p className="text-[11px] font-semibold text-blue-900 mb-1.5 flex items-center gap-1">
            <Link2 className="h-3 w-3" /> Razorpay payment link
          </p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Payment ID" value={row.payment_reference || notOnFile} />
            <Field label="Link ID" value={row.razorpay_link_id || notOnFile} />
            <Field
              label="Bank settlement"
              value={row.settled_at
                ? <span className="text-green-700 font-medium">{formatDate(row.settled_at)}</span>
                : <span className="text-muted-foreground italic">awaiting settlement</span>}
            />
            {row.settlement_id && <Field label="Settlement ref" value={row.settlement_id} />}
          </div>
          {row.razorpay_link_url && (
            <Button size="sm" variant="outline" className="h-7 gap-1 mt-2 bg-white" asChild>
              <a href={row.razorpay_link_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3 w-3" /> Open in Razorpay
              </a>
            </Button>
          )}
          {!row.settled_at && (
            <p className="text-[11px] text-blue-800/70 mt-2">
              Razorpay settles to bank on a T+2/T+3 cycle. The settlement date appears here
              once the daily recon picks it up.
            </p>
          )}
        </div>
      )}

      {row.collection_method !== "razorpay" && (
        <div className="mt-3">
          {row.payment_proof_url ? (
            <Button size="sm" variant="outline" className="h-8 gap-1.5" asChild>
              <a href={row.payment_proof_url} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" /> View payment proof
              </a>
            </Button>
          ) : (
            <p className="text-xs text-amber-700 flex items-center gap-1.5">
              <FileWarning className="h-3.5 w-3.5 shrink-0" />
              {row.collection_method === "manual"
                ? "No payment proof was attached when this deposit was recorded."
                : "How this deposit was collected was never recorded — verify against the bank statement before booking."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function UploadReceiptDialog({ row, onClose, onDone }: {
  row: DepositInboxRow; onClose: () => void; onDone: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!file) { toast.error("Choose the Tally receipt PDF first"); return; }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/accounting/inbox/deposits/${row.kind}/${row.id}/account`, {
        method: "POST", body: fd,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Upload failed");
      toast.success("Deposit accounted");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload Tally Receipt</DialogTitle>
          <DialogDescription>
            {row.party_name} · {amountLabel(row.amount)} — uploading marks this deposit as accounted.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Tally receipt / voucher PDF</Label>
          <input
            type="file"
            accept="application/pdf,image/*"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            className="block w-full text-sm border rounded-md p-2"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={submit} disabled={submitting || !file}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Mark Accounted"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReopenDialog({ row, onClose, onDone }: {
  row: DepositInboxRow; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    if (!reason.trim()) { toast.error("A reason is required"); return; }
    setSubmitting(true);
    try {
      const res = await fetch(`/api/accounting/inbox/deposits/${row.kind}/${row.id}/account`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not reopen");
      toast.success("Reopened — it's back in the pending list");
      onDone();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not reopen");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-amber-600" /> Reopen Deposit
          </DialogTitle>
          <DialogDescription>
            {row.party_name} · {amountLabel(row.amount)} — this removes the uploaded receipt and moves it back to Pending.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Reason for reopening</Label>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being reopened…" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="destructive" onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reopen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

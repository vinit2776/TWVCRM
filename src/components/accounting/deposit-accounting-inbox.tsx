"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Upload, Loader2, ExternalLink, RotateCcw, CheckCircle2, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
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

  const load = useCallback(async (tab: "open" | "closed") => {
    setLoading(true);
    try {
      const res = await fetch(`/api/accounting/inbox/deposits?tab=${tab}`);
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

  useEffect(() => { load(subTab); }, [subTab, load]);

  const isAdmin = currentUserRole === "admin";

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
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
          {rows.map((row) => (
            <div
              key={`${row.kind}-${row.id}`}
              className="flex items-center justify-between gap-4 rounded-lg border p-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
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
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {row.contract_number || row.proposal_number || "—"}
                  {row.payment_reference ? ` · Ref: ${row.payment_reference}` : ""}
                  {row.payment_medium ? ` · ${row.payment_medium}` : ""}
                  {" · "}{row.paid_at ? formatDate(row.paid_at) : (
                    <span className="text-amber-600">date not on file</span>
                  )}
                </p>
                {subTab === "closed" && row.accounted_at && (
                  <p className="text-[11px] text-green-700 mt-0.5">
                    Accounted by {row.accounted_by_name || "—"} on {formatDate(row.accounted_at)}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className={row.amount == null ? "text-xs text-amber-600 italic" : "font-semibold text-sm"}>
                  {amountLabel(row.amount)}
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
                          <ExternalLink className="h-3.5 w-3.5" /> View
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
          ))}
        </div>
      )}

      {uploadTarget && (
        <UploadReceiptDialog
          row={uploadTarget}
          onClose={() => setUploadTarget(null)}
          onDone={() => { setUploadTarget(null); load(subTab); }}
        />
      )}
      {reopenTarget && (
        <ReopenDialog
          row={reopenTarget}
          onClose={() => setReopenTarget(null)}
          onDone={() => { setReopenTarget(null); load(subTab); }}
        />
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

"use client";

import { useEffect, useMemo, useState } from "react";
import { Send, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils";

/** A preview older than this must be re-run before it can be sent. */
export const PREVIEW_STALE_AFTER_MS = 10 * 60 * 1000;

export interface RunSendItem {
  contract_number: string;
  customer_name?: string;
  total_amount: number;
  tax_amount: number;
  supersedes?: string;
}

interface RunSendConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  periodLabel: string;
  items: RunSendItem[];
  /** Contracts the run will skip because a proforma was already sent. */
  alreadySent: string[];
  /** Contracts in the preview that were not in the last completed run. */
  newSinceLastRun: Set<string>;
  /** When the preview was fetched (ms epoch); null if unknown. */
  previewedAt: number | null;
  running: boolean;
  onConfirm: () => void;
  onRerunPreview: () => void;
}

/**
 * Gate in front of the live rent dispatch. Sending reaches real customers with
 * live payment links, so it shows what is about to happen and requires a
 * deliberate, count-specific confirmation (tick + typed phrase).
 */
export function RunSendConfirmDialog({
  open, onOpenChange, periodLabel, items, alreadySent, newSinceLastRun,
  previewedAt, running, onConfirm, onRerunPreview,
}: RunSendConfirmDialogProps) {
  const [checked, setChecked] = useState(false);
  const [typed, setTyped] = useState("");
  const [showAll, setShowAll] = useState(false);
  // Sampled when the dialog opens: Date.now() is impure during render.
  const [openedAt, setOpenedAt] = useState(0);

  useEffect(() => {
    if (open) {
      setChecked(false);
      setTyped("");
      setShowAll(false);
      setOpenedAt(Date.now());
    }
  }, [open]);

  const count = items.length;
  const phrase = `SEND ${count}`;
  const stale = previewedAt !== null && openedAt - previewedAt > PREVIEW_STALE_AFTER_MS;

  const stats = useMemo(() => {
    const customers = new Set(items.map((i) => i.customer_name || i.contract_number)).size;
    const total = items.reduce((s, i) => s + i.total_amount, 0);
    const gst = items.reduce((s, i) => s + (i.tax_amount || 0), 0);
    const sorted = [...items].sort((a, b) => b.total_amount - a.total_amount);
    return { customers, total, gst, largest: sorted[0], smallest: sorted[sorted.length - 1], sorted };
  }, [items]);

  const replaced = new Set(items.map((i) => i.supersedes).filter(Boolean) as string[]).size;
  const newOnes = items.filter((i) => newSinceLastRun.has(i.contract_number)).map((i) => i.contract_number);
  const canSend = checked && typed.trim().toUpperCase() === phrase && !running && count > 0;
  const rows = showAll ? stats.sorted : stats.sorted.slice(0, 3);

  if (stale) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Preview is out of date</DialogTitle></DialogHeader>
          <div className="flex gap-2 rounded-md bg-red-50 p-3 text-sm text-red-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            This preview was run more than 10 minutes ago. Contracts may have changed since, so run Preview again to see what will actually be sent.
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={() => { onOpenChange(false); onRerunPreview(); }}>Re-run preview</Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Send {count} rent proforma{count !== 1 ? "s" : ""} for {periodLabel}?</DialogTitle>
        </DialogHeader>

        <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <strong>This sends real messages with live payment links to {stats.customers} customer{stats.customers !== 1 ? "s" : ""}.</strong>{" "}
          It can&rsquo;t be undone once sent.
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Invoices" value={String(count)} hint={`to ${stats.customers} customer${stats.customers !== 1 ? "s" : ""}`} />
          <Stat label="Total billed" value={formatCurrency(stats.total)} hint={`incl. GST ${formatCurrency(stats.gst)}`} />
          {stats.largest && (
            <Stat label="Largest" value={formatCurrency(stats.largest.total_amount)} hint={stats.largest.contract_number} />
          )}
        </div>

        {(newOnes.length > 0 || replaced > 0 || alreadySent.length > 0) && (
          <div className="space-y-1.5">
            <h4 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Worth a look before you send</h4>
            {newOnes.length > 0 && (
              <Flag tone="blue" label={`${newOnes.length} new`}>
                since the last completed run: {newOnes.slice(0, 5).join(", ")}{newOnes.length > 5 ? ` +${newOnes.length - 5} more` : ""}
              </Flag>
            )}
            {replaced > 0 && (
              <Flag tone="green" label={`${replaced} replaced`}>
                legacy combined draft{replaced !== 1 ? "s" : ""} will be voided. They were never sent, so no customer impact.
              </Flag>
            )}
            {alreadySent.length > 0 && (
              <Flag tone="gray" label={`${alreadySent.length} skipped`}>
                already sent: {alreadySent.slice(0, 5).join(", ")}{alreadySent.length > 5 ? ` +${alreadySent.length - 5} more` : ""}
              </Flag>
            )}
          </div>
        )}

        <div>
          <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recipients ({count}) — largest first
          </h4>
          <div className="max-h-48 overflow-auto rounded-md border text-xs">
            {rows.map((i) => (
              <div key={i.contract_number} className="flex justify-between gap-2 border-b px-2.5 py-1.5 last:border-0">
                <span className="truncate">{i.contract_number}{i.customer_name ? ` · ${i.customer_name}` : ""}</span>
                <span className="tabular-nums">{formatCurrency(i.total_amount)}</span>
              </div>
            ))}
          </div>
          {count > 3 && (
            <button type="button" className="mt-1 text-xs font-semibold text-[#015E65]" onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Show fewer" : `Show all ${count}`}
            </button>
          )}
        </div>

        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} className="mt-0.5" />
          <span>I&rsquo;ve checked the preview list and the totals above.</span>
        </label>
        <div>
          <p className="mb-1 text-xs text-muted-foreground">Type <strong>{phrase}</strong> to confirm</p>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" className="font-mono" disabled={running} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>Cancel</Button>
          <Button onClick={onConfirm} disabled={!canSend}>
            {running ? (
              <><span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" />Sending…</>
            ) : (
              <><Send className="mr-2 h-4 w-4" />Send {count} proforma{count !== 1 ? "s" : ""}</>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-2.5 py-2">
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="truncate text-[11px] text-muted-foreground">{hint}</div>
    </div>
  );
}

const TONES = {
  blue: "bg-blue-50 text-blue-900",
  green: "bg-green-50 text-green-900",
  gray: "bg-gray-100 text-gray-700",
} as const;

function Flag({ tone, label, children }: { tone: keyof typeof TONES; label: string; children: React.ReactNode }) {
  return (
    <div className={`flex gap-2 rounded-md px-2.5 py-1.5 text-[13px] ${TONES[tone]}`}>
      <strong className="whitespace-nowrap">{label}</strong>
      <span>{children}</span>
    </div>
  );
}

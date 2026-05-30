"use client";

import { useState, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Receipt, Eye, Send, ChevronRight } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

type Mode = "rent" | "usage";

interface PreviewItem {
  contract_number: string;
  customer_name?: string;
  type: "rent" | "usage";
  period_label: string;
  subtotal: number;
  tax_amount: number;
  cgst_amount?: number;
  sgst_amount?: number;
  total_amount: number;
  line_items?: { description: string; amount: number; note?: string }[];
  note?: string;
  supersedes?: string;
}

interface ProformaBillingCardProps {
  mode: Mode;
  /** Human label shown in card title — e.g. "June 2026" for rent, "May 2026" for usage */
  periodLabel: string;
  /** Operational deadline label — e.g. "Sat, 30 May" for rent. Pass undefined for usage. */
  deadlineLabel?: string;
  /** When true, show the amber reminder banner at the top of the card */
  showReminder?: boolean;
  /** Reminder text override */
  reminderText?: React.ReactNode;
  /**
   * Usage mode only: count of existing draft usage statements waiting on
   * Finalize+Send. Surfaces these in the card so they don't get missed during
   * the Generate Drafts flow (admin sees both pending and to-be-generated).
   */
  pendingDraftsCount?: number;
  /** Called when the live run completes successfully so the parent can refresh lists */
  onSuccess?: () => void | Promise<void>;
}

/**
 * Per-flow action card: Preview (dry-run) → Run.
 *
 * Rent mode  → "Run & Send" — dispatches live proformas to clients.
 * Usage mode → "Generate Drafts" — creates Pending Review entries for admin to verify and send later.
 *
 * The two cards are independent. Rent runs on the last working day before
 * month-end (so clients have time to pay). Usage runs AFTER month-end so the
 * draft reflects the full month of charges (no last-day-of-month edits missed).
 */
export function ProformaBillingCard({
  mode,
  periodLabel,
  deadlineLabel,
  showReminder = false,
  reminderText,
  pendingDraftsCount = 0,
  onSuccess,
}: ProformaBillingCardProps) {
  const isRent = mode === "rent";

  const [previewItems, setPreviewItems] = useState<PreviewItem[] | null>(null);
  const [expandedRow, setExpandedRow]   = useState<string | null>(null);
  const [alreadySent, setAlreadySent]   = useState<string[]>([]);
  const [previewing, setPreviewing]     = useState(false);
  const [previewed, setPreviewed]       = useState(false);
  const [running, setRunning]           = useState(false);
  const [confirmOpen, setConfirmOpen]   = useState(false);
  const [doneThisCycle, setDoneThisCycle] = useState<boolean | null>(null);

  const handlePreview = async () => {
    setPreviewing(true);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dry_run: true, mode }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Preview failed"); return; }
      const items: PreviewItem[] = isRent
        ? (json.rent_proformas?.preview ?? [])
        : (json.usage_statements?.preview ?? []);
      const skipped: string[] = isRent
        ? (json.rent_proformas?.already_sent ?? [])
        : (json.usage_statements?.already_sent ?? []);
      setPreviewItems(items);
      setAlreadySent(skipped);
      setPreviewed(true);
      setDoneThisCycle(items.length === 0 && skipped.length === 0);
      if (json.errors?.length) for (const e of json.errors) toast.error(e);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  };

  const handleRun = async () => {
    setRunning(true);
    try {
      const res = await fetch("/api/billing/auto-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error || "Run failed"); return; }
      const generated = isRent ? (json.rent_proformas?.generated ?? 0) : (json.usage_statements?.generated ?? 0);
      const noContact = isRent ? (json.rent_proformas?.no_contact ?? []) : [];
      const errors: string[] = json.errors ?? [];
      const message = isRent
        ? `${generated} rent proforma${generated !== 1 ? "s" : ""} sent to clients`
        : `${generated} usage draft${generated !== 1 ? "s" : ""} created for review`;
      toast.success(message);
      if (noContact.length > 0) {
        toast.warning(`${noContact.length} contract${noContact.length > 1 ? "s" : ""} have no email/phone — proforma not sent: ${noContact.join(", ")}`);
      }
      // Itemize failures cleanly. One summary toast + a single info toast
      // listing all failed contract numbers so the operator can target
      // recovery via the per-row Resend Proforma button instead of guessing.
      if (errors.length > 0) {
        toast.error(`${errors.length} contract${errors.length !== 1 ? "s" : ""} failed — use Resend Proforma on the affected rows`);
        const summary = errors.slice(0, 10).join("\n") + (errors.length > 10 ? `\n…and ${errors.length - 10} more` : "");
        toast(summary, { duration: 15000 });
      }
      setConfirmOpen(false);
      setPreviewItems(null);
      setAlreadySent([]);
      setPreviewed(false);
      setDoneThisCycle(true);
      if (onSuccess) await onSuccess();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  };

  const supersedeCount = previewItems
    ? new Set(previewItems.map(i => i.supersedes).filter(Boolean) as string[]).size
    : 0;
  const rentTotal = previewItems
    ? previewItems.reduce((s, i) => s + i.total_amount, 0)
    : 0;

  const title = isRent ? `Monthly Rent Proforma — ${periodLabel}` : `Monthly Usage Drafts — ${periodLabel}`;
  const blurb = isRent
    ? "Auto-finalizes and sends rent proformas to clients with payment links. Run on the last working day before month-end."
    : "Creates usage drafts in the Pending Review queue. No client dispatch — admin reviews each draft and sends individually. Run after month-end so all charges are captured.";
  const runLabel = isRent ? "Run & Send" : "Generate Drafts";
  const runDisabledTitle = !previewed ? "Preview first to enable" : (isRent ? "Generate, finalize, and send proformas" : "Create draft usage statements");

  return (
    <div className="rounded-lg border bg-card p-4">
      {showReminder && (
        <div className="mb-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
          {reminderText ?? <>⏰ <strong>{title}</strong> hasn&rsquo;t been run yet.</>}
        </div>
      )}
      {/* Usage mode: surface existing unfinalized drafts so they don't get missed */}
      {!isRent && pendingDraftsCount > 0 && (
        <div className="mb-3 rounded-md border border-orange-300 bg-orange-50 px-3 py-2 text-sm text-orange-900">
          <strong>⚠ {pendingDraftsCount} usage draft{pendingDraftsCount !== 1 ? "s" : ""} pending review</strong>
          {" — finalize and send each in the Proforma Statements section below (Usage filter chip). Don&rsquo;t let them carry forward unsent."}
        </div>
      )}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Receipt className={`h-4 w-4 ${isRent ? "text-[#015E65]" : "text-purple-600"}`} />
            {title}
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {blurb}
            {deadlineLabel && <> <span className="text-amber-700 font-medium">Deadline: {deadlineLabel}.</span></>}
            {doneThisCycle === true && <span className="text-green-700 font-medium"> ✓ Nothing pending.</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" onClick={handlePreview} disabled={previewing}>
            {previewing ? (
              <><span className="mr-2 h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin inline-block" />Previewing…</>
            ) : (
              <><Eye className="mr-2 h-4 w-4" />Preview</>
            )}
          </Button>
          <Button
            onClick={() => setConfirmOpen(true)}
            disabled={!previewed || running}
            title={runDisabledTitle}
          >
            <Send className="mr-2 h-4 w-4" />{runLabel}
          </Button>
        </div>
      </div>

      {/* Preview results */}
      {previewItems && (
        <div className="mt-4 rounded-md border overflow-x-auto">
          <div className="px-3 py-2 bg-muted/50 text-xs font-medium flex items-center justify-between">
            <span>Preview — {previewItems.length} {isRent ? "rent proforma" : "usage draft"}{previewItems.length !== 1 ? "s" : ""} would be created (nothing {isRent ? "sent" : "generated"} yet)</span>
            <span className="text-muted-foreground">Total {isRent ? "rent" : "usage"} value: ₹{rentTotal.toLocaleString("en-IN")}</span>
          </div>
          {alreadySent.length > 0 && (
            <div className="px-3 py-2 bg-green-50 border-b text-xs text-green-900">
              ✓ {alreadySent.length} contract{alreadySent.length !== 1 ? "s" : ""} already billed (skipped to avoid double-billing): {alreadySent.join(", ")}
            </div>
          )}
          {previewItems.length === 0 ? (
            <p className="text-xs text-muted-foreground px-3 py-3">Nothing to {isRent ? "generate" : "create"} — all contracts are already covered for this period.</p>
          ) : (
            <>
            <div className="mb-2 px-3 py-2 text-[11px] text-blue-900 bg-blue-50 border-b">
              ℹ Proforma numbers (TWV-BS-NNNN) are assigned only when you click <strong>Run &amp; Send</strong>. Click any row below to see the line-item breakdown that will appear on the proforma.
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30">
                  <th className="px-3 py-2 text-left font-medium w-6"></th>
                  <th className="px-3 py-2 text-left font-medium">Contract</th>
                  <th className="px-3 py-2 text-left font-medium">Customer</th>
                  <th className="px-3 py-2 text-left font-medium hidden md:table-cell">Period</th>
                  <th className="px-3 py-2 text-right font-medium">Subtotal</th>
                  <th className="px-3 py-2 text-right font-medium">GST</th>
                  <th className="px-3 py-2 text-right font-medium">Total</th>
                  <th className="px-3 py-2 text-left font-medium hidden lg:table-cell">Note</th>
                </tr>
              </thead>
              <tbody>
                {[...previewItems].sort((a, b) => a.contract_number.localeCompare(b.contract_number, undefined, { numeric: true })).map((it) => {
                  const rowKey = it.contract_number;
                  const isExpanded = expandedRow === rowKey;
                  const hasBreakdown = (it.line_items?.length ?? 0) > 0;
                  return (
                    <Fragment key={rowKey}>
                      <tr
                        className={`border-b ${hasBreakdown ? "cursor-pointer hover:bg-muted/30" : ""}`}
                        onClick={() => hasBreakdown && setExpandedRow(isExpanded ? null : rowKey)}
                      >
                        <td className="px-3 py-2">
                          {hasBreakdown && (
                            <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                          )}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs">{it.contract_number}</td>
                        <td className="px-3 py-2 text-xs">{it.customer_name || "—"}</td>
                        <td className="px-3 py-2 text-muted-foreground hidden md:table-cell">{it.period_label}</td>
                        <td className="px-3 py-2 text-right">{formatCurrency(it.subtotal)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{formatCurrency(it.tax_amount)}</td>
                        <td className="px-3 py-2 text-right font-medium">{formatCurrency(it.total_amount)}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground hidden lg:table-cell">
                          {it.note}
                          {it.supersedes && <span className="block text-amber-700 mt-0.5">supersedes {it.supersedes}</span>}
                        </td>
                      </tr>
                      {isExpanded && hasBreakdown && (
                        <tr className="border-b bg-blue-50/30">
                          <td colSpan={8} className="px-6 py-3">
                            <div className="rounded-md bg-white border p-3">
                              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">
                                Proforma Preview — {it.contract_number} · {it.period_label}
                              </p>
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="border-b text-muted-foreground">
                                    <th className="text-left py-1 font-medium">Line Item</th>
                                    <th className="text-right py-1 font-medium">Amount</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {it.line_items!.map((li, i) => (
                                    <tr key={i} className="border-b last:border-0">
                                      <td className="py-1.5">
                                        {li.description}
                                        {li.note && <span className="ml-2 text-[10px] text-amber-700">({li.note})</span>}
                                      </td>
                                      <td className="py-1.5 text-right">{formatCurrency(li.amount)}</td>
                                    </tr>
                                  ))}
                                  <tr className="border-t-2 border-t-muted-foreground/20">
                                    <td className="py-1.5 text-muted-foreground">Subtotal (taxable value)</td>
                                    <td className="py-1.5 text-right font-medium">{formatCurrency(it.subtotal)}</td>
                                  </tr>
                                  {it.cgst_amount != null && (
                                    <tr>
                                      <td className="py-1 text-muted-foreground">CGST @ 9%</td>
                                      <td className="py-1 text-right text-muted-foreground">{formatCurrency(it.cgst_amount)}</td>
                                    </tr>
                                  )}
                                  {it.sgst_amount != null && (
                                    <tr>
                                      <td className="py-1 text-muted-foreground">SGST @ 9%</td>
                                      <td className="py-1 text-right text-muted-foreground">{formatCurrency(it.sgst_amount)}</td>
                                    </tr>
                                  )}
                                  <tr className="border-t-2 border-t-muted-foreground/30 font-semibold">
                                    <td className="py-1.5">Grand Total</td>
                                    <td className="py-1.5 text-right">{formatCurrency(it.total_amount)}</td>
                                  </tr>
                                </tbody>
                              </table>
                              <p className="text-[10px] text-muted-foreground mt-3 italic">
                                Place of supply: Tamil Nadu · The proforma number will be assigned on Run &amp; Send.
                              </p>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
            </>
          )}
        </div>
      )}

      {/* Run confirmation dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{isRent ? "Run & send" : "Generate"} {isRent ? "rent proformas" : "usage drafts"} for {periodLabel}?</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {previewItems && (
              <div className={`rounded-md border px-3 py-2 ${isRent ? "border-amber-300 bg-amber-50 text-amber-900" : "border-purple-300 bg-purple-50 text-purple-900"}`}>
                {isRent ? (
                  <>
                    This will finalize and <strong>send {previewItems.length} live proforma{previewItems.length !== 1 ? "s" : ""} with payment links to clients</strong>.
                    <br />Total rent value: ₹{rentTotal.toLocaleString("en-IN")}
                  </>
                ) : (
                  <>
                    This will create <strong>{previewItems.length} draft usage statement{previewItems.length !== 1 ? "s" : ""}</strong> in the Pending Review queue.
                    <br />No client dispatch — admin reviews each draft and sends individually.
                    <br />Total usage value (after review): ₹{rentTotal.toLocaleString("en-IN")}
                  </>
                )}
                {supersedeCount > 0 && (
                  <>
                    <br /><br />
                    <strong>{supersedeCount} legacy combined draft{supersedeCount !== 1 ? "s" : ""} will be voided</strong> and replaced. These drafts were never sent to clients — no client impact. Audit trail preserved.
                  </>
                )}
              </div>
            )}
            <p className="text-muted-foreground">
              {isRent
                ? "Rent proformas are dispatched immediately on confirm."
                : "Usage drafts can be reviewed individually in the Pending Review queue before sending."}
            </p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={running}>Cancel</Button>
            <Button onClick={handleRun} disabled={running}>
              {running ? (
                <><span className="mr-2 h-3 w-3 rounded-full border-2 border-current border-r-transparent animate-spin inline-block" />{isRent ? "Sending…" : "Creating…"}</>
              ) : (
                <><Send className="mr-2 h-4 w-4" />Confirm{isRent ? " & Send" : ""}</>
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Tiny badge used to label the card type in the billing page. */
export function ProformaCardTypeBadge({ mode }: { mode: Mode }) {
  return (
    <Badge variant="outline" className={mode === "rent" ? "border-teal-300 text-teal-700" : "border-purple-300 text-purple-700"}>
      {mode === "rent" ? "Rent" : "Usage"}
    </Badge>
  );
}

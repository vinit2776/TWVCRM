"use client";

import {
  Cloud, Loader2, Clock, CheckCircle2, Send, XCircle, AlertTriangle, RotateCw, Hash,
} from "lucide-react";

/**
 * TallyStatusBadge — surfaces where a TALLY-issued GST invoice is in Tally's
 * lifecycle (separate from the CRM BillingLifecycleStatus, which tracks the CRM
 * flow). Renders nothing for CRM-issued statements (issuance_channel != 'tally').
 *
 * Designed so NO state is a dead-end:
 *   - in-progress stages (queued/issuing/issued/cancelling) self-resolve via the
 *     bridge + reconcile cron → shown as "in progress"
 *   - awaiting_irn → a clear instruction (accounts generates the IRN in Tally)
 *   - failed → a Retry action (compact shows a small button; full shows the error)
 *   - sent/cancelled → terminal, with the invoice/IRN/credit-note numbers
 */

export interface TallyStatusFields {
  issuance_channel?: string | null;
  lifecycle_stage?: string | null;
  tally_invoice_number?: string | null;
  tally_irn?: string | null;
  tally_credit_note_number?: string | null;
  tally_last_error?: string | null;
  tally_delivered_at?: string | null;
}

type Tone = "muted" | "progress" | "warn" | "ok" | "error";

const TONE_PILL: Record<Tone, string> = {
  muted:    "bg-gray-100 text-gray-600 border border-gray-200",
  progress: "bg-blue-50 text-blue-700 border border-blue-200",
  warn:     "bg-amber-50 text-amber-800 border border-amber-300",
  ok:       "bg-green-50 text-green-700 border border-green-200",
  error:    "bg-red-50 text-red-700 border border-red-200",
};

interface Resolved {
  label: string;
  tone: Tone;
  Icon: React.ElementType;
  spin?: boolean;
  /** A short next-action / explanation so the state is never a dead-end. */
  hint?: string;
  /** True when a Retry action should be offered. */
  canRetry?: boolean;
}

function resolve(f: TallyStatusFields): Resolved {
  const stage = f.lifecycle_stage ?? null;
  const inv = f.tally_invoice_number;
  switch (stage) {
    case "queued":
      return { label: "Queued for Tally", tone: "progress", Icon: Clock, hint: "Waiting for the Tally bridge to pick it up." };
    case "issuing":
      return { label: "Posting to Tally…", tone: "progress", Icon: Loader2, spin: true, hint: "The bridge is creating the voucher." };
    case "awaiting_irn":
      return {
        label: "Awaiting IRN", tone: "warn", Icon: Clock,
        hint: `B2B invoice ${inv ?? ""} created in Tally — generate its IRN in Tally to send the client.`.trim(),
      };
    case "issued":
      return { label: "Issued · delivering", tone: "progress", Icon: Loader2, spin: true, hint: `Invoice ${inv ?? ""} issued; delivering to the customer.`.trim() };
    case "sent":
      return { label: "Sent via Tally", tone: "ok", Icon: CheckCircle2 };
    case "cancelling":
      return { label: "Cancelling (credit note)…", tone: "progress", Icon: Loader2, spin: true, hint: "Posting a credit note in Tally to reverse this invoice." };
    case "cancelled":
      return { label: "Cancelled in Tally", tone: "muted", Icon: XCircle, hint: f.tally_credit_note_number ? `Reversed by credit note ${f.tally_credit_note_number}.` : undefined };
    case "failed":
      return { label: "Tally error", tone: "error", Icon: AlertTriangle, canRetry: true, hint: f.tally_last_error ?? "The bridge could not post to Tally." };
    default:
      // issuance_channel='tally' but no stage yet (just stamped) → queued-ish.
      return inv
        ? { label: "In Tally", tone: "ok", Icon: Cloud }
        : { label: "Queued for Tally", tone: "progress", Icon: Clock, hint: "Waiting for the Tally bridge." };
  }
}

interface Props extends TallyStatusFields {
  variant?: "compact" | "full";
  /** Called when the user clicks Retry (failed state). */
  onRetry?: () => void;
  retrying?: boolean;
}

export function TallyStatusBadge(props: Props) {
  // Only meaningful for Tally-issued statements.
  if (props.issuance_channel !== "tally") return null;

  const { variant = "compact", onRetry, retrying } = props;
  const r = resolve(props);

  const pill = (
    <span className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-xs font-medium whitespace-nowrap ${TONE_PILL[r.tone]}`}>
      <r.Icon className={`h-3 w-3 shrink-0 ${r.spin ? "animate-spin" : ""}`} />
      {r.label}
    </span>
  );

  if (variant === "compact") {
    return (
      <div className="flex items-center gap-1.5 min-w-0">
        {pill}
        {r.canRetry && onRetry && (
          <button
            type="button"
            onClick={onRetry}
            disabled={retrying}
            className="inline-flex items-center gap-1 text-[11px] text-red-600 hover:text-red-800 disabled:opacity-50"
            title="Retry posting to Tally"
          >
            <RotateCw className={`h-3 w-3 ${retrying ? "animate-spin" : ""}`} />
            Retry
          </button>
        )}
      </div>
    );
  }

  // Full variant — used in the statement detail dialog.
  return (
    <div className="rounded-lg border p-3 space-y-2 bg-muted/30">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-muted-foreground flex items-center gap-1.5">
          <Cloud className="h-3.5 w-3.5" /> Tally
        </span>
        {pill}
      </div>

      {r.hint && <p className="text-xs text-muted-foreground">{r.hint}</p>}

      <div className="grid grid-cols-1 gap-1 text-xs">
        {props.tally_invoice_number && (
          <div className="flex items-center gap-1.5"><Hash className="h-3 w-3 text-muted-foreground" /><span className="text-muted-foreground">Invoice</span><span className="font-medium">{props.tally_invoice_number}</span></div>
        )}
        {props.tally_irn && (
          <div className="flex items-center gap-1.5"><CheckCircle2 className="h-3 w-3 text-green-600" /><span className="text-muted-foreground">IRN</span><span className="font-mono text-[11px] break-all">{props.tally_irn}</span></div>
        )}
        {props.tally_credit_note_number && (
          <div className="flex items-center gap-1.5"><XCircle className="h-3 w-3 text-muted-foreground" /><span className="text-muted-foreground">Credit note</span><span className="font-medium">{props.tally_credit_note_number}</span></div>
        )}
        {props.tally_delivered_at && (
          <div className="flex items-center gap-1.5"><Send className="h-3 w-3 text-muted-foreground" /><span className="text-muted-foreground">Delivered</span><span>{new Date(props.tally_delivered_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short" })}</span></div>
        )}
      </div>

      {r.canRetry && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 text-white text-xs font-medium hover:bg-red-700 disabled:opacity-50"
        >
          <RotateCw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} />
          {retrying ? "Retrying…" : "Retry Tally sync"}
        </button>
      )}
    </div>
  );
}

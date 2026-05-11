"use client";

/**
 * BillingLifecycleStatus — compact stepper showing where a billing
 * statement is in its lifecycle and what's holding it up.
 *
 * Steps:
 *   1. Generated    — draft created
 *   2. Reviewed     — staff has looked at it (finalized or confirm-sent)
 *   3. Invoice Sent — GST invoice emailed to customer
 *   4. Payment Link — Razorpay link created (optional — some pay by NEFT)
 *   5. Payment      — partially or fully paid
 *   6. Accounted    — entered into books
 *
 * Renders as: ●●●○○○  Label
 * The label shows the NEXT action needed (where it's stuck).
 */

interface LifecycleProps {
  status: string;
  emailed_at?: string | null;
  razorpay_payment_link_url?: string | null;
  payment_status?: string | null;
  accounted?: boolean | null;
  finalized_at?: string | null;
  gst_invoice_number?: string | null;
  /** compact = dots only with tooltip; full = dots + label inline */
  variant?: "compact" | "full";
}

interface Step {
  key: string;
  label: string;
  done: boolean;
}

function resolveSteps(props: LifecycleProps): Step[] {
  const {
    status,
    emailed_at,
    razorpay_payment_link_url,
    payment_status,
    accounted,
    finalized_at,
    gst_invoice_number,
  } = props;

  const isFinalized = status === "finalized" || status === "exported";
  const hasInvoice = !!gst_invoice_number || !!finalized_at;
  const isEmailed = !!emailed_at;
  const hasPayLink = !!razorpay_payment_link_url;
  const isPaid = payment_status === "paid";
  const isPartiallyPaid = payment_status === "partially_paid";
  const isAccounted = !!accounted;

  return [
    { key: "generated", label: "Generated", done: true }, // always true if we have a row
    { key: "reviewed", label: "Reviewed", done: isFinalized || hasInvoice },
    { key: "invoiced", label: "Invoice sent", done: isEmailed && hasInvoice },
    { key: "pay_link", label: "Payment link", done: hasPayLink || isPaid || isPartiallyPaid },
    { key: "payment", label: "Payment", done: isPaid || isPartiallyPaid },
    { key: "accounted", label: "Accounted", done: isAccounted },
  ];
}

function getCurrentLabel(steps: Step[], props: LifecycleProps): { text: string; color: string } {
  const { payment_status } = props;

  // Find first incomplete step
  const firstIncomplete = steps.find((s) => !s.done);

  if (!firstIncomplete) {
    return { text: "Complete", color: "text-green-700" };
  }

  // Payment is a special case — partially paid shows differently
  if (firstIncomplete.key === "payment" && payment_status === "partially_paid") {
    return { text: "Partially paid", color: "text-amber-700" };
  }

  const labelMap: Record<string, { text: string; color: string }> = {
    reviewed:  { text: "Awaiting review", color: "text-gray-600" },
    invoiced:  { text: "Invoice not sent", color: "text-amber-700" },
    pay_link:  { text: "No payment link", color: "text-amber-600" },
    payment:   { text: "Awaiting payment", color: "text-orange-700" },
    accounted: { text: "Not accounted", color: "text-blue-700" },
  };

  return labelMap[firstIncomplete.key] || { text: "In progress", color: "text-gray-600" };
}

export function BillingLifecycleStatus(props: LifecycleProps) {
  const { variant = "compact", status } = props;

  // Voided statements get a special red badge instead of the stepper
  if (status === "voided") {
    return (
      <div className="flex items-center gap-1.5" title="This statement has been voided">
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-red-500" />
        <span className="text-[11px] font-medium text-red-700 whitespace-nowrap">Voided</span>
      </div>
    );
  }

  const steps = resolveSteps(props);
  const completedCount = steps.filter((s) => s.done).length;
  const { text, color } = getCurrentLabel(steps, props);

  // Build tooltip text listing all steps
  const tooltipLines = steps
    .map((s) => `${s.done ? "✓" : "•"} ${s.label}`)
    .join("\n");
  const tooltipText = `${text}\n\n${tooltipLines}`;

  return (
    <div
      className="flex items-center gap-1.5"
      title={tooltipText}
    >
      {/* Dots */}
      <div className="flex items-center gap-0.5">
        {steps.map((step, i) => (
          <span
            key={step.key}
            className={`inline-block h-1.5 w-1.5 rounded-full ${
              step.done
                ? completedCount === steps.length
                  ? "bg-green-500"
                  : "bg-primary"
                : "bg-gray-300"
            }`}
          />
        ))}
      </div>

      {/* Label — only in full variant */}
      {variant === "full" && (
        <span className={`text-xs font-medium whitespace-nowrap ${color}`}>
          {text}
        </span>
      )}

      {/* Compact variant shows a tiny label on hover via the title attr above,
          but also shows a short inline hint */}
      {variant === "compact" && (
        <span className={`text-[11px] whitespace-nowrap ${color}`}>
          {text}
        </span>
      )}
    </div>
  );
}

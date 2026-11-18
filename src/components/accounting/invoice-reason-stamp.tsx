import type { InvoiceReason, InvoiceReasonGroup } from "@/lib/invoice-reason";

const STYLE: Record<InvoiceReasonGroup, string> = {
  recurring: "bg-teal-50 text-teal-900 border-teal-200",
  one_off: "bg-violet-50 text-violet-900 border-violet-200",
  virtual_office: "bg-orange-50 text-orange-900 border-orange-200",
};

/** Why this invoice was raised. Colour = family: teal recurring, violet one-off, orange Virtual Office. */
export function InvoiceReasonStamp({ reason }: { reason: InvoiceReason | null }) {
  if (!reason) return null;
  return (
    <span
      className={`text-[11px] font-semibold px-1.5 py-0.5 rounded border flex-shrink-0 ${STYLE[reason.group]}`}
      title={reason.hint}
    >
      {reason.label}
    </span>
  );
}

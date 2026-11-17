import Link from "next/link";
import { OctagonAlert } from "lucide-react";

export interface RetiredPoFacts {
  id?: string;
  po_number: string;
  status?: string;
  amc_terminated_at?: string | null;
  amc_termination_reason?: string | null;
}

/** "terminated" (AMC ended early), "cancelled" (PO cancelled), or null when the order is still good. */
export function retiredPoKind(po: RetiredPoFacts | null | undefined): "terminated" | "cancelled" | null {
  if (!po) return null;
  if (po.amc_terminated_at) return "terminated";
  if (po.status === "cancelled") return "cancelled";
  return null;
}

const NOUN = { terminated: "AMC TERMINATED", cancelled: "PO CANCELLED" } as const;

/** Small red tag for list rows, so a bill on a dead contract is never mistaken for a normal one. */
export function RetiredAmcChip({ po }: { po: RetiredPoFacts | null | undefined }) {
  const kind = retiredPoKind(po);
  if (!kind) return null;
  return (
    <span
      className="mt-0.5 inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
      title={`${po!.po_number}: ${kind === "terminated" ? "this AMC was terminated" : "this purchase order was cancelled"}. Check before paying.`}
    >
      <OctagonAlert className="h-3 w-3 shrink-0" />
      {NOUN[kind]}
    </span>
  );
}

/**
 * Full-width banner for a bill whose contract is dead. Shown on the bill and on the payment screen,
 * most loudly while the bill is approved and still waiting to be paid.
 */
export function RetiredAmcBanner({
  po,
  billStatus,
  fullyPaid,
}: {
  po: RetiredPoFacts | null | undefined;
  billStatus: string;
  fullyPaid: boolean;
}) {
  const kind = retiredPoKind(po);
  if (!po || !kind) return null;
  const live = billStatus === "approved" && !fullyPaid;
  const what = kind === "terminated" ? "This AMC has been TERMINATED" : "This purchase order has been CANCELLED";
  return (
    <div
      role="alert"
      className={`rounded-xl border-4 p-5 ${live ? "border-red-600 bg-red-50" : "border-amber-500 bg-amber-50"}`}
    >
      <div className="flex items-start gap-4">
        <OctagonAlert className={`h-10 w-10 shrink-0 ${live ? "text-red-600" : "text-amber-600"}`} />
        <div className="space-y-1">
          <p className={`text-2xl font-extrabold uppercase tracking-wide ${live ? "text-red-700" : "text-amber-800"}`}>
            {what}
          </p>
          <p className={`text-base font-semibold ${live ? "text-red-800" : "text-amber-900"}`}>
            {live
              ? "This bill is still APPROVED and waiting to be paid. Do not pay it unless you are sure it is owed."
              : fullyPaid
                ? "This bill is already paid. Nothing to do."
                : "This bill is not approved for payment."}
          </p>
          <p className="text-sm text-muted-foreground">
            {po.id ? (
              <Link href={`/procurement/orders/${po.id}`} className="font-mono font-medium underline">{po.po_number}</Link>
            ) : (
              <span className="font-mono font-medium">{po.po_number}</span>
            )}
            {po.amc_termination_reason ? ` · Reason: ${po.amc_termination_reason}` : ""}
          </p>
          {live && (
            <p className="text-sm text-red-900">
              If it should not be paid: open {po.id ? <Link href={`/procurement/orders/${po.id}`} className="underline">the PO</Link> : "the PO"}{" "}
              → Correct → <strong>Withdraw its unpaid bills</strong>. That takes it off this list.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

import { AlertCircle, ShieldCheck, ShieldQuestion } from "lucide-react";
import type { InvoiceSeal } from "@/lib/procurement/invoice-check";

const STYLE = {
  verified: { box: "border-emerald-300 bg-emerald-50 text-emerald-800", title: "Verified against the invoice", Icon: ShieldCheck },
  overridden: { box: "border-amber-300 bg-amber-50 text-amber-800", title: "Saved with differences", Icon: AlertCircle },
  not_verified: { box: "border-slate-300 bg-slate-50 text-slate-700", title: "Not verified", Icon: ShieldQuestion },
  changed_after: { box: "border-amber-300 bg-amber-50 text-amber-800", title: "Edited after the check", Icon: AlertCircle },
} as const;

/** Shown only when the check really passed; every other state says why it isn't, so people read the bill themselves. */
export function InvoiceSealBadge({ seal }: { seal: InvoiceSeal }) {
  const { box, title, Icon } = STYLE[seal.state];
  return (
    <div className={`flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-xs ${box}`} data-seal={seal.state}>
      <Icon className="h-4 w-4 flex-shrink-0 mt-0.5" aria-hidden />
      <p><span className="font-medium">{title}</span> — {seal.reason}</p>
    </div>
  );
}

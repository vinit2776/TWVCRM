"use client";

/**
 * BillingModeTag — compact badge showing a contract's billing dispatch mode.
 *
 * proforma_first (default): customer receives a Proforma Invoice + payment link.
 *   GST invoice is issued only after payment is confirmed.
 * gst_direct: GST tax invoice is issued immediately on finalize, no PI step.
 *
 * Used on RentTable rows, UsageTable rows, and ViewStatementDialog header.
 */

import { Badge } from "@/components/ui/badge";

interface Props {
  mode?: string | null;
}

export function BillingModeTag({ mode }: Props) {
  if (!mode || mode === "proforma_first") {
    return (
      <Badge className="bg-slate-100 text-slate-500 border-slate-200 text-[10px] font-normal">
        PI First
      </Badge>
    );
  }
  if (mode === "gst_direct") {
    return (
      <Badge className="bg-violet-100 text-violet-700 border-violet-200 text-[10px] font-normal">
        GST Direct
      </Badge>
    );
  }
  return null;
}

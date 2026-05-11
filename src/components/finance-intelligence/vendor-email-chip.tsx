"use client";

import { MailX } from "lucide-react";

/**
 * Tiny inline indicator: "📧 no email". Used in payables list rows and
 * accounting page rows so the gap is visible at a glance without
 * clicking into a bill. Click stops propagation so it doesn't trigger
 * the row click.
 */
export function VendorEmailChip({
  vendorId,
  className,
}: {
  vendorId: string;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full bg-amber-100 text-amber-800 px-1.5 py-0.5 text-[10px] font-medium ${className ?? ""}`}
      title={`Vendor ${vendorId.slice(0, 8)} has no email — payment confirmations cannot be sent`}
    >
      <MailX className="h-2.5 w-2.5" />
      no email
    </span>
  );
}

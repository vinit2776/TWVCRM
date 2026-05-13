"use client";

import { MailX } from "lucide-react";

/**
 * Inline indicator shown on bill list rows when the vendor has no email.
 * Opens the bill detail (where the user can add the email inline).
 * Click stops propagation so it doesn't double-trigger the row click.
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
      className={`inline-flex items-center gap-1 rounded-full bg-amber-100 border border-amber-300 text-amber-800 px-2 py-0.5 text-[11px] font-medium ${className ?? ""}`}
      title={`This vendor has no email on file — open the bill to add it before recording payment`}
      onClick={(e) => e.stopPropagation()}
    >
      <MailX className="h-3 w-3 shrink-0" />
      Email missing
    </span>
  );
}

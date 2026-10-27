import { Pencil } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";

interface BillEditedBadgeProps {
  editCount?: number | null;
  editedAt?: string | null;
  summary?: string | null;
  className?: string;
}

/** Shown on a vendor bill that was corrected after entry, so the change gets a second look. */
export function BillEditedBadge({ editCount, editedAt, summary, className }: BillEditedBadgeProps) {
  if (!editCount || editCount < 1) return null;
  const title = [
    `Edited ${editCount === 1 ? "once" : `${editCount} times`}`,
    editedAt ? `last on ${formatDate(editedAt)}` : null,
    summary ? `— ${summary}` : null,
  ].filter(Boolean).join(" ");
  return (
    <span
      title={title}
      data-testid="bill-edited-badge"
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800",
        className
      )}
    >
      <Pencil className="h-2.5 w-2.5" />
      Edited{editCount > 1 ? ` ×${editCount}` : ""}
    </span>
  );
}

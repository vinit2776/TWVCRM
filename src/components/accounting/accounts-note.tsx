import { MessageSquareWarning } from "lucide-react";

/**
 * The internal note whoever raised the statement left for accounts. Amber and
 * unmissable on purpose: it often says what the invoice is for or what to watch.
 * Not printed on the customer's invoice.
 */
export function AccountsNote({ note, compact = false }: { note: string; compact?: boolean }) {
  return (
    <div
      className={`col-span-2 rounded border border-amber-300 bg-amber-50 text-amber-950 ${compact ? "px-2 py-1 text-xs" : "px-3 py-2 text-sm"}`}
      role="note"
    >
      <div className="flex items-center gap-1 text-[0.65rem] font-semibold uppercase tracking-wide text-amber-800">
        <MessageSquareWarning className="h-3 w-3" aria-hidden /> Note for accounts
      </div>
      <p className={`whitespace-pre-wrap leading-snug ${compact ? "line-clamp-3" : ""}`}>{note}</p>
    </div>
  );
}

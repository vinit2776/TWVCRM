"use client";

import { MessageCircleQuestion } from "lucide-react";

/**
 * The "Query" toggle that sits in a Tally Inbox row's action strip.
 *
 * Deliberately separate from <QueryButton>: that one owns its own expansion
 * state and fetches its own count, which is right for a detail page but wrong
 * inside a list, where the row already owns expansion state and the count
 * arrives batched with the row data. This is presentational only — the caller
 * keeps the state and renders <QueryThreadPanel> itself.
 *
 * One component so bookings, deposits and statements can't drift apart, since
 * the badge is how you tell at a glance which rows are blocked on an answer.
 */
export function InboxQueryButton({
  open,
  openCount,
  onToggle,
  title,
}: {
  open: boolean;
  openCount: number;
  onToggle: () => void;
  /** Tooltip — say what kind of record this asks about. */
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`inline-flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors ${
        open ? "bg-blue-50 border-blue-300 text-blue-800" : "hover:bg-muted"
      }`}
      title={title}
      aria-expanded={open}
    >
      <MessageCircleQuestion className="h-3 w-3" />
      Query
      {openCount > 0 && (
        <span className="text-[10px] leading-none bg-blue-700 text-white rounded-full px-1.5 py-0.5 ml-0.5">
          {openCount}
        </span>
      )}
    </button>
  );
}

"use client";

import { useState } from "react";
import { Pin } from "lucide-react";
import { toast } from "sonner";
import type { Lead } from "@/types";

/**
 * Pin or unpin a lead. A pinned lead stays highlighted in the list and shown on every calendar day,
 * whatever its follow-up date, until someone unpins it.
 */
export function LeadPinButton({
  lead,
  onChanged,
  withLabel = false,
}: {
  lead: Pick<Lead, "id" | "pinned_at" | "archived_at">;
  onChanged: () => void;
  withLabel?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const pinned = !!lead.pinned_at;
  if (lead.archived_at && !pinned) return null;

  return (
    <button
      type="button"
      disabled={busy}
      title={pinned ? "Unpin: stop keeping this in front of the team" : "Pin: keep this in front of the team until unpinned"}
      aria-pressed={pinned}
      onClick={async (e) => {
        e.stopPropagation();
        setBusy(true);
        try {
          const res = await fetch(`/api/leads/${lead.id}/pin`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pinned: !pinned }),
          });
          if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || "Could not change the pin");
          }
          toast.success(pinned ? "Unpinned" : "Pinned");
          onChanged();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not change the pin");
        } finally {
          setBusy(false);
        }
      }}
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs font-medium disabled:opacity-60 ${
        pinned ? "border-amber-400 bg-amber-100 text-amber-800" : "text-muted-foreground hover:bg-muted"
      }`}
    >
      <Pin className={`h-3.5 w-3.5 ${pinned ? "fill-amber-500" : ""}`} />
      {withLabel && (pinned ? "Pinned" : "Pin")}
    </button>
  );
}

"use client";

import { useState } from "react";
import { Flag, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { flagTooltip } from "@/lib/lead-sheet";
import type { Lead } from "@/types";

export type FlagFields = Pick<Lead, "flagged_at" | "flag_reason" | "flagger">;

/**
 * The flag on a lead: click the flag, say why, save. A flagged lead shows the reason and who set
 * it, and can be cleared. Staff only; nothing is sent to the customer.
 */
export function LeadFlagControl({ lead, onChanged }: { lead: Pick<Lead, "id" | "flagged_at" | "flag_reason" | "flagger">; onChanged: (fields: FlagFields) => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const flagged = !!lead.flagged_at;

  async function save() {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/flag`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not flag it");
      onChanged({ flagged_at: json.data.flagged_at, flag_reason: json.data.flag_reason, flagger: json.data.flagger });
      toast.success("Flagged");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${lead.id}/flag`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Could not clear the flag");
      onChanged({ flagged_at: null, flag_reason: null, flagger: null });
      toast.success("Flag cleared");
      setOpen(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (o) setReason(lead.flag_reason ?? "");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label={flagged ? "Flagged. Edit or clear the flag" : "Flag this lead"}
          title={flagged ? flagTooltip(lead) : "Flag this lead"}
          className={`rounded p-1.5 hover:bg-black/10 ${flagged ? "text-orange-700" : "text-muted-foreground"}`}
        >
          <Flag className="h-4 w-4" fill={flagged ? "currentColor" : "none"} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-2" onClick={(e) => e.stopPropagation()}>
        <div className="text-sm font-semibold">{flagged ? "Flagged" : "Flag this lead"}</div>
        {flagged && <div className="text-xs text-muted-foreground">{flagTooltip(lead)}</div>}
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why? (a few words, shown on hover)"
          maxLength={300}
          rows={3}
        />
        <div className="flex items-center justify-between gap-2">
          {flagged ? (
            <Button variant="outline" size="sm" onClick={clear} disabled={busy}>
              Clear flag
            </Button>
          ) : (
            <span />
          )}
          <Button size="sm" onClick={save} disabled={busy || reason.trim().length < 3}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : flagged ? "Update" : "Flag"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

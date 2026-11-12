"use client";

import { useState } from "react";
import { ShieldCheck, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CheckAccountingNoteButtonProps {
  note: string;
  accountingHead?: string;
  context?: string;
}

/**
 * Manual "check my wording before I submit" button for internal accounting
 * notes. This button itself never blocks anything — failures/timeouts degrade
 * silently — but the same grading is enforced server-side on submit for
 * ad-hoc invoices (create and edit), so a form using this button may still
 * reject the note at submit time even if this button reported no issues were
 * found (submit re-checks the final text, which could differ from what was
 * checked here).
 *
 * TODO: the inline warning block was rendering incorrectly — using a plain
 * alert() as a stopgap until that's root-caused.
 */
export function CheckAccountingNoteButton({ note, accountingHead, context }: CheckAccountingNoteButtonProps) {
  const [loading, setLoading] = useState(false);

  const handleCheck = async () => {
    if (!note.trim()) {
      toast.error("Write a note first");
      return;
    }
    setLoading(true);
    try {
      const res = await fetch("/api/accounting/validate-internal-note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note, accounting_head: accountingHead, context }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json && typeof json.ok === "boolean") {
        if (json.ok) {
          toast.success("Looks good — clear context for accounts");
        } else {
          alert(`${json.reason || "This note may not give accounts enough context"} — you can still submit as-is.`);
        }
      }
      // Silently degrade on non-ok responses (503 unconfigured, 502 model error, etc.)
      // — this is advisory only and must never block the user.
    } catch {
      // Network failure — advisory, no toast.
    } finally {
      setLoading(false);
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={handleCheck}
      disabled={loading}
      className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
    >
      {loading ? (
        <Loader2 className="h-3 w-3 mr-1 animate-spin" />
      ) : (
        <ShieldCheck className="h-3 w-3 mr-1" />
      )}
      Check wording
    </Button>
  );
}

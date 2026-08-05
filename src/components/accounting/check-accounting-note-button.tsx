"use client";

import { useState } from "react";
import { ShieldCheck, Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface CheckAccountingNoteButtonProps {
  note: string;
  accountingHead?: string;
  context?: string;
}

/**
 * Advisory-only wording check for internal accounting notes (ad-hoc invoices,
 * security deposit requests, deposit top-ups). Never blocks submission —
 * failures/timeouts degrade silently, same as the "Improve wording"
 * suggestion button this mirrors (src/components/billing/improve-wording-button.tsx).
 */
export function CheckAccountingNoteButton({ note, accountingHead, context }: CheckAccountingNoteButtonProps) {
  const [loading, setLoading] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  const handleCheck = async () => {
    if (!note.trim()) {
      toast.error("Write a note first");
      return;
    }
    setLoading(true);
    setWarning(null);
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
          setWarning(json.reason || "This note may not give accounts enough context");
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
    <div className="space-y-1.5">
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
      {warning && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{warning} — you can still submit as-is.</span>
        </div>
      )}
    </div>
  );
}

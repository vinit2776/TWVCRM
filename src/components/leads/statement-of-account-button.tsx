"use client";

import { useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { soaRange } from "@/lib/statement-of-account";

type Period = "current" | "previous" | "both";

/** Download-only: nothing is sent to the customer. */
export function StatementOfAccountButton({ leadId }: { leadId: string }) {
  const [busy, setBusy] = useState(false);
  const options: { period: Period; label: string }[] = [
    { period: "current", label: soaRange("current").label },
    { period: "previous", label: soaRange("previous").label },
    { period: "both", label: "Both years" },
  ];

  async function download(period: Period) {
    setBusy(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/statement-of-account?period=${period}`);
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        throw new Error(j?.error || "Could not build the statement");
      }
      const blob = await res.blob();
      const name = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "")?.[1] || "Statement-of-Account.pdf";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not build the statement");
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={busy}>
          {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileDown className="mr-2 h-4 w-4" />}
          Statement of Account
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {options.map((o) => (
          <DropdownMenuItem key={o.period} onClick={() => download(o.period)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

"use client";

import { useState } from "react";
import { toast } from "sonner";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiErrorMessage } from "@/lib/utils";
import { emitApprovalChanged } from "@/lib/approval-events";

interface Props {
  approvalId: string;
  onActed: () => void;
}

// Same call the Approvals page makes, so the decision can be taken from the
// renewal itself — that page isn't visited often.
export function EscalationApprovalActions({ approvalId, onActed }: Props) {
  const [acting, setActing] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const act = async (action: "approve" | "reject") => {
    if (action === "reject" && !reason.trim()) {
      toast.error("Enter a rejection reason");
      return;
    }
    setActing(true);
    try {
      const res = await fetch(`/api/approval-requests/${approvalId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(action === "reject" ? { rejection_reason: reason.trim() } : {}),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(apiErrorMessage(json.error, `Failed to ${action}`));
        return;
      }
      toast.success(json.message || `Request ${action}d`);
      emitApprovalChanged();
      onActed();
    } finally {
      setActing(false);
    }
  };

  return (
    <div className="space-y-2 pt-1">
      {rejecting && (
        <Input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason for rejection (required)…"
          className="h-8 text-xs bg-white"
        />
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1 h-8 text-xs bg-emerald-600 hover:bg-emerald-700"
          disabled={acting}
          onClick={() => act("approve")}
        >
          {acting ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle2 className="h-3 w-3 mr-1" />}
          Approve
        </Button>
        {rejecting ? (
          <Button
            size="sm"
            variant="destructive"
            className="flex-1 h-8 text-xs"
            disabled={acting || !reason.trim()}
            onClick={() => act("reject")}
          >
            <XCircle className="h-3 w-3 mr-1" />
            Confirm reject
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="flex-1 h-8 text-xs text-destructive hover:text-destructive"
            onClick={() => { setRejecting(true); setReason(""); }}
          >
            <XCircle className="h-3 w-3 mr-1" />
            Reject
          </Button>
        )}
      </div>
    </div>
  );
}

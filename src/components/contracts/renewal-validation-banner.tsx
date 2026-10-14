"use client";

import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/utils";
import type { Contract } from "@/types";

interface Props {
  contract: Contract;
  userRole: string | null;
  onChanged: () => void;
  onEditTerms: () => void;
}

/**
 * Shown on an auto-created renewal draft. Until a person validates it the
 * server refuses to send it to the customer (see unvalidatedAutoDraftReason).
 */
export function RenewalValidationBanner({ contract, userRole, onChanged, onEditTerms }: Props) {
  const [saving, setSaving] = useState(false);
  if (!contract.is_renewal || !contract.renewal_auto_created) return null;

  const canValidate = ["admin", "manager", "sales_rep"].includes(userRole ?? "");

  if (contract.renewal_validated_at) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-green-200 bg-green-50 px-4 py-2.5 text-sm text-green-800">
        <CheckCircle2 className="h-4 w-4 shrink-0" />
        Auto-created renewal, validated {formatDate(contract.renewal_validated_at)}.
      </div>
    );
  }

  const validate = async () => {
    setSaving(true);
    const res = await fetch(`/api/contracts/${contract.id}/validate-renewal`, { method: "POST" });
    setSaving(false);
    if (res.ok) {
      toast.success("Renewal validated");
      onChanged();
    } else {
      const err = await res.json().catch(() => null);
      toast.error(err?.error || "Couldn't validate the renewal");
    }
  };

  return (
    <div className="rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1 space-y-2">
          <p>
            <span className="font-medium">Needs validation.</span> This draft was created automatically
            {contract.renewal_auto_created_at ? ` on ${formatDate(contract.renewal_auto_created_at)}` : ""}.
            Check the rate, seats and dates, then validate. It can&apos;t be sent to the customer until you do.
          </p>
          {canValidate && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={validate} disabled={saving}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Validate renewal
              </Button>
              <Button size="sm" variant="outline" onClick={onEditTerms} disabled={saving}>
                Edit terms first
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

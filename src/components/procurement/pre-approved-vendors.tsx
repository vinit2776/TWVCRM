"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Receipt, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useCurrentUser } from "@/providers/current-user-provider";
import { formatCurrency } from "@/lib/utils";

interface ActiveRule {
  id: string;
  vendor_id: string;
  billing_cycle: string;
  expected_amount: number;
  tolerance_percent: number;
  max_auto_approve_amount: number;
  first_bill_id: string | null;
  procurement_vendors: { id: string; name: string } | null;
}

// Same roles the bills API allows to create a bill (POST /api/procurement/bills).
const BILL_CREATOR_ROLES = ["admin", "manager", "office_admin"];

const CYCLE_LABELS: Record<string, string> = { monthly: "monthly", quarterly: "quarterly", yearly: "yearly" };

function useActiveRules() {
  const [rules, setRules] = useState<ActiveRule[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/procurement/recurring-bill-rules")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((json) => { if (!cancelled) setRules(json.data ?? []); })
      .catch(() => { /* a missing shortcut must never break the page */ });
    return () => { cancelled = true; };
  }, []);
  return rules;
}

function useCanSubmitBill() {
  const { user } = useCurrentUser();
  return BILL_CREATOR_ROLES.includes(user?.role ?? "");
}

/** Strip listing vendors with an active rule, each linking to a pre-filled New Bill. */
export function PreApprovedVendorsStrip() {
  const rules = useActiveRules();
  const canSubmit = useCanSubmitBill();
  if (rules.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-green-600" />
          Pre-approved vendors
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Bills from these vendors skip approval when they are within the limits. No request needed — submit the bill directly.
        </p>
      </CardHeader>
      <CardContent className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2">
        {rules.map((rule) => (
          <div
            key={rule.id}
            className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 ${rule.first_bill_id ? "" : "border-dashed"}`}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium truncate">{rule.procurement_vendors?.name ?? "Vendor"}</p>
              {rule.first_bill_id ? (
                <p className="text-xs text-muted-foreground">
                  About {formatCurrency(rule.expected_amount)} · ±{rule.tolerance_percent}% · up to {formatCurrency(rule.max_auto_approve_amount)} · {CYCLE_LABELS[rule.billing_cycle] ?? rule.billing_cycle}
                </p>
              ) : (
                <p className="text-xs text-amber-700">Rule waiting on its first bill · still needs manual approval</p>
              )}
            </div>
            {canSubmit && (
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <Link href={`/procurement/bills/new?vendor_id=${rule.vendor_id}`}>Submit bill</Link>
              </Button>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/** Callout for the New Request screen — only shown when at least one vendor is pre-approved. */
export function PreApprovedBillCallout() {
  const rules = useActiveRules();
  const canSubmit = useCanSubmitBill();
  if (rules.length === 0) return null;

  return (
    <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
      <Receipt className="h-4 w-4 mt-0.5 shrink-0 text-blue-600" />
      <div className="space-y-2">
        <div>
          <p className="font-medium">Got a bill from a pre-approved vendor?</p>
          <p className="text-xs text-blue-800 mt-0.5">
            Recurring bills (internet, rent and similar) don&apos;t need a request. Submit the bill directly and it goes to Accounts for payment.
            {!canSubmit && " Ask your office admin or manager to submit it as a bill."}
          </p>
        </div>
        {canSubmit && (
          <div className="flex items-center gap-2">
            <Button asChild size="sm">
              <Link href="/procurement/bills/new">Submit a bill</Link>
            </Button>
            <span className="text-xs">or continue below for a one-off purchase</span>
          </div>
        )}
      </div>
    </div>
  );
}

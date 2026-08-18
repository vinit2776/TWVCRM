"use client";

/**
 * LeadDepositSummary — consolidated security-deposit picture for a
 * customer, pooled across every contract they hold (not just one
 * deposit_carried_from renewal chain — see 00502_pooled_customer_deposits.sql).
 *
 * Sits next to LeadBillingSnippet on the lead profile: that answers "how
 * much has this customer paid us", this answers "how much deposit do we
 * hold against them, across all their contracts, and is any of it still
 * owed."
 */

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ShieldCheck, Loader2 } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { CONTRACT_STATUS_LABELS } from "@/lib/constants";

interface ContractBreakdownRow {
  contract_id: string;
  contract_number: string;
  status: string;
  required: number;
  collected: number;
  refunded: number;
  is_renewal_child: boolean;
}

interface DepositSummary {
  lead_id: string;
  total_required: number;
  deposit_collected: number;
  committed: number;
  available: number;
  unavailable_reason: string | null;
  contracts: ContractBreakdownRow[];
}

interface Props {
  leadId: string;
}

export function LeadDepositSummary({ leadId }: Props) {
  const [data, setData] = useState<DepositSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/leads/${leadId}/deposit-summary`)
      .then((r) => r.json())
      .then((j) => setData(j.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [leadId]);

  if (loading) {
    return (
      <Card id="security-deposit">
        <CardContent className="p-4">
          <div className="text-xs text-muted-foreground py-6 text-center flex items-center justify-center gap-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading…
          </div>
        </CardContent>
      </Card>
    );
  }

  // No contracts at all for this lead — nothing to show.
  if (!data || data.contracts.length === 0) return null;

  const multiContract = data.contracts.length > 1;

  return (
    <Card id="security-deposit">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-emerald-600" />
          <h3 className="text-sm font-semibold">
            Security deposit{multiContract ? " (consolidated across all contracts)" : ""}
          </h3>
        </div>

        <div className="grid grid-cols-3 gap-2">
          <Tile label="Required" value={formatCurrency(data.total_required)} tone="slate" />
          <Tile label="Available" value={formatCurrency(data.available)} tone="emerald" />
          <Tile label="Committed" value={formatCurrency(data.committed)} tone="blue" />
        </div>

        {multiContract && (
          <div className="border-t pt-2 space-y-1">
            {data.contracts.map((c) => (
              <div key={c.contract_id} className="flex items-center justify-between text-[11px]">
                <span className="text-muted-foreground">
                  {c.contract_number}
                  {c.is_renewal_child && <span className="ml-1 text-[10px]">(renewal, carries forward)</span>}
                  <span className="ml-1 text-[10px]">
                    · {CONTRACT_STATUS_LABELS[c.status as keyof typeof CONTRACT_STATUS_LABELS] || c.status}
                  </span>
                </span>
                <span className="tabular-nums">
                  {c.required > 0 ? `required ${formatCurrency(c.required)}` : "—"}
                  {c.collected > 0 && <> · collected <strong className="text-foreground">{formatCurrency(c.collected)}</strong></>}
                  {c.refunded > 0 && <> · refunded {formatCurrency(c.refunded)}</>}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone: "emerald" | "blue" | "slate" }) {
  const tones = {
    emerald: "bg-emerald-50 text-emerald-900 border-emerald-200",
    blue:    "bg-blue-50    text-blue-900    border-blue-200",
    slate:   "bg-slate-50   text-slate-900   border-slate-200",
  };
  return (
    <div className={`rounded-md border px-3 py-2 ${tones[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-base font-bold mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

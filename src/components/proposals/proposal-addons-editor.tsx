"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatCurrency } from "@/lib/utils";
import { addonsMonthlyTotal } from "@/lib/recurring-addons";
import type { ProposalAddon } from "@/types";

interface Props {
  addons: ProposalAddon[];
  onChange: (addons: ProposalAddon[]) => void;
  escalationPercentage: number;
  onEscalationChange: (value: number) => void;
  /** Sum of the monthly fee lines above, excluding GST. */
  monthlyFee: number;
  depositMonths: number;
}

/**
 * The part of a proposal that is not the monthly fee: the agreed escalation on
 * that fee, and the recurring add-ons that never escalate. Add-ons are kept out
 * of the line items so the security deposit and the escalation only ever read
 * the monthly fee.
 */
export function ProposalAddonsEditor({
  addons,
  onChange,
  escalationPercentage,
  onEscalationChange,
  monthlyFee,
  depositMonths,
}: Props) {
  const update = (index: number, patch: Partial<ProposalAddon>) =>
    onChange(addons.map((a, i) => (i === index ? { ...a, ...patch } : a)));
  const addonsTotal = addonsMonthlyTotal(addons);

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <Label htmlFor="proposal-escalation" className="text-sm font-semibold">
            Annual escalation on the monthly fee
          </Label>
          <div className="flex items-center gap-1">
            <Input
              id="proposal-escalation"
              type="number"
              min={0}
              max={100}
              step="0.5"
              className="w-20 text-right"
              value={Number.isFinite(escalationPercentage) ? escalationPercentage : ""}
              onChange={(e) => onEscalationChange(e.target.value === "" ? NaN : Number(e.target.value))}
            />
            <span className="text-sm">%</span>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Defaults to 10%. Change it to the number agreed with the customer. It applies to the line items above only,
          never to the add-ons below.
        </p>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <Label className="text-sm font-semibold">Recurring add-ons</Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Monthly extras such as parking, a name board or a locker. They are not escalated, are not part of the
              security deposit, and can be switched off later from the contract.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onChange([...addons, { description: "", amount: 0 }])}
          >
            <Plus className="mr-1 h-4 w-4" />
            Add add-on
          </Button>
        </div>

        {addons.length === 0 ? (
          <p className="text-xs text-muted-foreground italic">No add-ons on this proposal.</p>
        ) : (
          <div className="space-y-2">
            {addons.map((addon, index) => (
              <div key={index} className="grid grid-cols-12 gap-2 items-center">
                <div className="col-span-7">
                  <Input
                    placeholder="e.g. Valet car parking"
                    value={addon.description}
                    onChange={(e) => update(index, { description: e.target.value })}
                  />
                </div>
                <div className="col-span-4">
                  <Input
                    type="number"
                    min={0}
                    placeholder="₹ per month"
                    value={addon.amount || ""}
                    onChange={(e) => update(index, { amount: Number(e.target.value) })}
                  />
                </div>
                <div className="col-span-1 flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove add-on ${index + 1}`}
                    onClick={() => onChange(addons.filter((_, i) => i !== index))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Each add-on runs for the full contract term. Dates can be changed on the contract if the customer asks.
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
        <div className="rounded-md border bg-blue-50 px-3 py-2">
          <p className="text-xs text-muted-foreground">Monthly fee (escalates)</p>
          <p className="font-semibold tabular-nums">{formatCurrency(monthlyFee)}</p>
        </div>
        <div className="rounded-md border bg-amber-50 px-3 py-2">
          <p className="text-xs text-muted-foreground">Recurring add-ons</p>
          <p className="font-semibold tabular-nums">{formatCurrency(addonsTotal)}</p>
        </div>
        <div className="rounded-md border px-3 py-2">
          <p className="text-xs text-muted-foreground">Total per month, before GST</p>
          <p className="font-semibold tabular-nums">{formatCurrency(monthlyFee + addonsTotal)}</p>
        </div>
      </div>
      {depositMonths > 0 && (
        <p className="text-xs text-muted-foreground">
          The security deposit is {depositMonths} month{depositMonths === 1 ? "" : "s"} of the monthly fee only
          ({formatCurrency(depositMonths * monthlyFee)}); add-ons are not counted.
        </p>
      )}
    </div>
  );
}

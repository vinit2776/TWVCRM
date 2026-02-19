"use client";

import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Save, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";

interface FacilityUsage {
  id?: string;
  contract_facility_id: string;
  quantity_used: number;
  free_quota_applied: number;
  billable_quantity: number;
  unit_price: number;
  total_charge: number;
  is_template?: boolean;
  notes?: string;
  contract_facility?: {
    id: string;
    name: string;
    unit: string;
    cost_per_unit: number;
    free_quota: number;
  };
}

interface FacilityUsageFormProps {
  usages: FacilityUsage[];
  contractId: string;
  accountingPeriodId: string;
  isLocked: boolean;
  onRefresh: () => void;
}

export function FacilityUsageForm({
  usages,
  contractId,
  accountingPeriodId,
  isLocked,
  onRefresh,
}: FacilityUsageFormProps) {
  const [editingValues, setEditingValues] = useState<Record<string, number>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

  const handleQuantityChange = (facilityId: string, value: number) => {
    setEditingValues((prev) => ({ ...prev, [facilityId]: value }));
  };

  const getDisplayQuantity = (usage: FacilityUsage) => {
    const key = usage.contract_facility_id;
    return editingValues[key] !== undefined ? editingValues[key] : usage.quantity_used;
  };

  const handleSave = async (usage: FacilityUsage) => {
    const key = usage.contract_facility_id;
    const quantity = editingValues[key];
    if (quantity === undefined || quantity === usage.quantity_used) return;

    setSaving((prev) => ({ ...prev, [key]: true }));
    try {
      if (usage.id && !usage.is_template) {
        // Update existing
        const res = await fetch(`/api/accounting/facility-usage/${usage.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity_used: quantity }),
        });
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.error || "Failed to update");
          return;
        }
      } else {
        // Create new
        const res = await fetch("/api/accounting/facility-usage", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accounting_period_id: accountingPeriodId,
            contract_id: contractId,
            contract_facility_id: usage.contract_facility_id,
            quantity_used: quantity,
          }),
        });
        if (!res.ok) {
          const err = await res.json();
          toast.error(err.error || "Failed to save");
          return;
        }
      }

      toast.success("Usage saved");
      setEditingValues((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      onRefresh();
    } catch {
      toast.error("Network error");
    } finally {
      setSaving((prev) => ({ ...prev, [key]: false }));
    }
  };

  if (usages.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-2">
        No facilities defined for this contract. Add facilities first.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      {/* Header */}
      <div className="grid grid-cols-[1fr_80px_80px_80px_80px_80px_40px] gap-2 text-xs font-medium text-muted-foreground px-2 py-1">
        <span>Facility</span>
        <span className="text-right">Free Quota</span>
        <span className="text-right">Used</span>
        <span className="text-right">Billable</span>
        <span className="text-right">Rate</span>
        <span className="text-right">Charge</span>
        <span></span>
      </div>

      {usages.map((usage) => {
        const facility = usage.contract_facility;
        const key = usage.contract_facility_id;
        const displayQty = getDisplayQuantity(usage);
        const hasChange = editingValues[key] !== undefined && editingValues[key] !== usage.quantity_used;
        const freeQuota = facility?.free_quota || 0;
        const billable = Math.max(0, displayQty - freeQuota);
        const rate = facility?.cost_per_unit || usage.unit_price || 0;
        const charge = billable * rate;

        return (
          <div
            key={key}
            className="grid grid-cols-[1fr_80px_80px_80px_80px_80px_40px] gap-2 items-center px-2 py-1.5 rounded hover:bg-accent/50"
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{facility?.name || "Unknown"}</span>
              <span className="text-xs text-muted-foreground">({facility?.unit})</span>
              {usage.is_template && (
                <Badge variant="outline" className="text-[10px] h-4">
                  template
                </Badge>
              )}
            </div>
            <span className="text-sm text-right text-muted-foreground">{freeQuota}</span>
            <div className="text-right">
              <Input
                type="number"
                min={0}
                step={0.01}
                value={displayQty}
                onChange={(e) => handleQuantityChange(key, parseFloat(e.target.value) || 0)}
                disabled={isLocked}
                className="h-7 w-20 text-right text-sm ml-auto"
              />
            </div>
            <span className="text-sm text-right">{billable}</span>
            <span className="text-sm text-right text-muted-foreground">{formatCurrency(rate)}</span>
            <span className="text-sm text-right font-medium">
              {formatCurrency(charge)}
            </span>
            <div className="flex justify-center">
              {hasChange && !isLocked && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={() => handleSave(usage)}
                  disabled={saving[key]}
                >
                  {saving[key] ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Save className="h-3 w-3" />
                  )}
                </Button>
              )}
            </div>
          </div>
        );
      })}

      {/* Total */}
      <div className="grid grid-cols-[1fr_80px_80px_80px_80px_80px_40px] gap-2 items-center px-2 py-1.5 border-t font-medium">
        <span className="text-sm">Total</span>
        <span></span>
        <span></span>
        <span></span>
        <span></span>
        <span className="text-sm text-right">
          {formatCurrency(
            usages.reduce((sum, u) => {
              const qty = getDisplayQuantity(u);
              const fq = u.contract_facility?.free_quota || 0;
              const rate = u.contract_facility?.cost_per_unit || u.unit_price || 0;
              return sum + Math.max(0, qty - fq) * rate;
            }, 0)
          )}
        </span>
        <span></span>
      </div>
    </div>
  );
}

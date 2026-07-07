"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Zap, Save, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Vendor { id: string; name: string }

interface Allocation {
  utility_allocated: number;
  generator_allocated: number;
  contract_count: number;
}

interface Props {
  locationId: string;
  canEdit: boolean;
}

const DEFAULTS = {
  enabled: false,
  service_number: null as string | null,
  landlord_vendor_id: null as string | null,
  landlord_utility_rate: 0,
  landlord_utility_pct: 90,
  landlord_generator_pct: 10,
  landlord_generator_rate: 30,
  bill_due_day_of_month: 15,
  landlord_gst_applicable: false,
  landlord_gst_rate: 18 as number | null,
  tds_section: null as string | null,
  tds_rate: null as number | null,
};

export function ElectricityConfigTab({ locationId, canEdit }: Props) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState(DEFAULTS);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [allocation, setAllocation] = useState<Allocation | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    const [cfgRes, vendorRes] = await Promise.all([
      fetch(`/api/locations/${locationId}/electricity-config`),
      fetch(`/api/procurement/vendors?limit=200`),
    ]);
    if (cfgRes.ok) {
      const json = await cfgRes.json();
      setAllocation(json.allocation ?? null);
      if (json.data) {
        setConfig(json.data);
        setForm({
          enabled: json.data.enabled,
          service_number: json.data.service_number ?? null,
          landlord_vendor_id: json.data.landlord_vendor_id,
          landlord_utility_rate: json.data.landlord_utility_rate ?? 0,
          landlord_utility_pct: json.data.landlord_utility_pct,
          landlord_generator_pct: json.data.landlord_generator_pct,
          landlord_generator_rate: json.data.landlord_generator_rate,
          bill_due_day_of_month: json.data.bill_due_day_of_month,
          landlord_gst_applicable: json.data.landlord_gst_applicable,
          landlord_gst_rate: json.data.landlord_gst_rate,
          tds_section: json.data.tds_section,
          tds_rate: json.data.tds_rate,
        });
      }
    }
    if (vendorRes.ok) {
      const json = await vendorRes.json();
      setVendors(json.data ?? []);
    }
    setLoading(false);
  }, [locationId]);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  const setLandlordUtility = (v: number) =>
    setForm((f) => ({ ...f, landlord_utility_pct: v, landlord_generator_pct: Math.max(0, 100 - v) }));

  const handleSave = async () => {
    setSaving(true);
    const res = await fetch(`/api/locations/${locationId}/electricity-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    if (res.ok) {
      setConfig(json.data);
      toast.success(config ? "Electricity settings updated" : "Electricity settings saved");
    } else {
      const msg = typeof json.error === "object"
        ? Object.values(json.error).flat().join("; ")
        : json.error;
      toast.error(msg || "Failed to save");
    }
    setSaving(false);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-20 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  const readOnly = !canEdit;

  return (
    <div className="space-y-6">
      {/* Master toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Electricity Sub-Billing
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Enable EB billing</p>
              <p className="text-xs text-muted-foreground">
                Activates landlord bill capture and per-contract customer re-billing
              </p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              disabled={readOnly}
            />
          </div>
        </CardContent>
      </Card>

      {/* Allocation summary (read-only) */}
      {allocation && allocation.contract_count > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Allocation Summary</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Across {allocation.contract_count} active contract{allocation.contract_count !== 1 ? "s" : ""} mapped to this location.
            </p>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <p className="font-medium">Grid (Utility)</p>
                <p className="text-muted-foreground">{allocation.utility_allocated.toFixed(1)}% allocated</p>
                {allocation.utility_allocated > 100 && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Over-allocated
                  </p>
                )}
                {allocation.utility_allocated < 100 && (
                  <p className="text-xs text-amber-600">
                    {(100 - allocation.utility_allocated).toFixed(1)}% unallocated (TWV absorbs)
                  </p>
                )}
              </div>
              <div>
                <p className="font-medium">DG (Generator)</p>
                <p className="text-muted-foreground">{allocation.generator_allocated.toFixed(1)}% allocated</p>
                {allocation.generator_allocated > 100 && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" /> Over-allocated
                  </p>
                )}
                {allocation.generator_allocated < 100 && (
                  <p className="text-xs text-amber-600">
                    {(100 - allocation.generator_allocated).toFixed(1)}% unallocated (TWV absorbs)
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Meter */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Meter</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1 md:col-span-2">
              <Label>Service Number</Label>
              <Input
                placeholder="e.g. MSEB-MH04-1234567890"
                value={form.service_number ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, service_number: e.target.value || null }))}
                disabled={readOnly}
              />
              <p className="text-xs text-muted-foreground">
                Utility meter account number — used for audit trail and future meter readings
              </p>
            </div>
            <div className="space-y-1 md:col-span-2">
              <Label>Landlord Vendor</Label>
              <Select
                value={form.landlord_vendor_id ?? "none"}
                onValueChange={(v) => setForm((f) => ({ ...f, landlord_vendor_id: v === "none" ? null : v }))}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select vendor…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— None —</SelectItem>
                  {vendors.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Bill due day of month</Label>
              <Input
                type="number" min={1} max={28}
                value={form.bill_due_day_of_month}
                onChange={(e) => setForm((f) => ({ ...f, bill_due_day_of_month: parseInt(e.target.value) || 15 }))}
                disabled={readOnly}
              />
              <p className="text-xs text-muted-foreground">Nag fires from this day in M+1 if no bill captured</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Landlord tariff */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Landlord Tariff</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Optional — for reference only. These rates just pre-fill the Rate column when capturing
            a monthly bill for this location; they don&apos;t drive any actual billing. Enter the real
            rate on each month&apos;s bill instead, since it can change month to month. Customer rates
            are set separately, per contract.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Grid / Utility rate (₹/unit)</Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.landlord_utility_rate}
                onChange={(e) => setForm((f) => ({ ...f, landlord_utility_rate: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1">
              <Label>DG / Generator rate (₹/unit)</Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.landlord_generator_rate}
                onChange={(e) => setForm((f) => ({ ...f, landlord_generator_rate: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1">
              <Label>Utility split % (landlord bill)</Label>
              <Input
                type="number" min={0} max={100} step={0.01}
                value={form.landlord_utility_pct}
                onChange={(e) => setLandlordUtility(parseFloat(e.target.value) || 0)}
                disabled={readOnly}
              />
              <p className="text-xs text-muted-foreground">% of bill amount that is grid units</p>
            </div>
            <div className="space-y-1">
              <Label>Generator split % (landlord bill)</Label>
              <Input
                type="number" min={0} max={100} step={0.01}
                value={form.landlord_generator_pct}
                onChange={(e) => setForm((f) => ({ ...f, landlord_generator_pct: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
              {Math.abs(form.landlord_utility_pct + form.landlord_generator_pct - 100) > 0.01 && (
                <p className="text-xs text-destructive">Must sum to 100%</p>
              )}
            </div>
          </div>

          <Separator />
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">GST / TDS on landlord invoice</p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="flex items-center justify-between md:col-span-2">
              <Label>GST applicable on landlord bill</Label>
              <Switch
                checked={form.landlord_gst_applicable}
                onCheckedChange={(v) => setForm((f) => ({ ...f, landlord_gst_applicable: v }))}
                disabled={readOnly}
              />
            </div>
            {form.landlord_gst_applicable && (
              <div className="space-y-1">
                <Label>GST rate %</Label>
                <Input
                  type="number" min={0} max={28} step={0.01}
                  value={form.landlord_gst_rate ?? 18}
                  onChange={(e) => setForm((f) => ({ ...f, landlord_gst_rate: parseFloat(e.target.value) || null }))}
                  disabled={readOnly}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>TDS section</Label>
              <Input
                placeholder="e.g. 194I"
                value={form.tds_section ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, tds_section: e.target.value || null }))}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1">
              <Label>TDS rate %</Label>
              <Input
                type="number" min={0} max={100} step={0.01}
                value={form.tds_rate ?? ""}
                onChange={(e) => setForm((f) => ({ ...f, tds_rate: parseFloat(e.target.value) || null }))}
                disabled={readOnly}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving…" : config ? "Update Settings" : "Save Settings"}
          </Button>
        </div>
      )}
    </div>
  );
}

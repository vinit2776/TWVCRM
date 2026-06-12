"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Zap, Save } from "lucide-react";
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

interface Props {
  locationId: string;
  /** admin or manager only — others see read-only view */
  canEdit: boolean;
}

const DEFAULTS = {
  enabled: false,
  reimbursement_enabled: true,
  landlord_vendor_id: null as string | null,
  landlord_utility_pct: 90,
  landlord_generator_pct: 10,
  landlord_generator_rate: 30,
  bill_due_day_of_month: 15,
  landlord_gst_applicable: false,
  landlord_gst_rate: 18 as number | null,
  tds_section: null as string | null,
  tds_rate: null as number | null,
  customer_utility_pct: 80,
  customer_generator_pct: 20,
  markup_type: "per_unit" as "per_unit" | "percent",
  markup_value: 0,
  customer_generator_rate: 30,
};

export function ElectricityConfigTab({ locationId, canEdit }: Props) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState(DEFAULTS);
  const [vendors, setVendors] = useState<Vendor[]>([]);
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
      if (json.data) {
        setConfig(json.data);
        setForm({
          enabled: json.data.enabled,
          reimbursement_enabled: json.data.reimbursement_enabled,
          landlord_vendor_id: json.data.landlord_vendor_id,
          landlord_utility_pct: json.data.landlord_utility_pct,
          landlord_generator_pct: json.data.landlord_generator_pct,
          landlord_generator_rate: json.data.landlord_generator_rate,
          bill_due_day_of_month: json.data.bill_due_day_of_month,
          landlord_gst_applicable: json.data.landlord_gst_applicable,
          landlord_gst_rate: json.data.landlord_gst_rate,
          tds_section: json.data.tds_section,
          tds_rate: json.data.tds_rate,
          customer_utility_pct: json.data.customer_utility_pct,
          customer_generator_pct: json.data.customer_generator_pct,
          markup_type: json.data.markup_type,
          markup_value: json.data.markup_value,
          customer_generator_rate: json.data.customer_generator_rate,
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

  // Keep split percentages in sync: changing utility auto-updates generator
  const setLandlordUtility = (v: number) =>
    setForm((f) => ({ ...f, landlord_utility_pct: v, landlord_generator_pct: Math.max(0, 100 - v) }));
  const setCustomerUtility = (v: number) =>
    setForm((f) => ({ ...f, customer_utility_pct: v, customer_generator_pct: Math.max(0, 100 - v) }));

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
                Activates landlord bill capture and customer re-billing for this location
              </p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              disabled={readOnly}
            />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Reimbursement enabled</p>
              <p className="text-xs text-muted-foreground">
                On: customer invoice generated. Off: vendor bill only (no customer statement).
              </p>
            </div>
            <Switch
              checked={form.reimbursement_enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, reimbursement_enabled: v }))}
              disabled={readOnly}
            />
          </div>
        </CardContent>
      </Card>

      {/* Landlord side */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Landlord / Payable Side</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Landlord vendor */}
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

            {/* Landlord splits */}
            <div className="space-y-1">
              <Label>Utility split % (landlord)</Label>
              <Input
                type="number" min={0} max={100} step={0.01}
                value={form.landlord_utility_pct}
                onChange={(e) => setLandlordUtility(parseFloat(e.target.value) || 0)}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1">
              <Label>Generator split % (landlord)</Label>
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

            <div className="space-y-1">
              <Label>Generator rate (₹/unit)</Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.landlord_generator_rate}
                onChange={(e) => setForm((f) => ({ ...f, landlord_generator_rate: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1">
              <Label>Bill due day of month</Label>
              <Input
                type="number" min={1} max={28}
                value={form.bill_due_day_of_month}
                onChange={(e) => setForm((f) => ({ ...f, bill_due_day_of_month: parseInt(e.target.value) || 15 }))}
                disabled={readOnly}
              />
              <p className="text-xs text-muted-foreground">
                Nag fires from this day in M+1 if no bill captured
              </p>
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
                <Label>Landlord GST rate %</Label>
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

      {/* Customer-side defaults */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer / Receivable Side — Defaults</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            These are defaults. Each contract can override them in its electricity settings.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Utility split % (customer)</Label>
              <Input
                type="number" min={0} max={100} step={0.01}
                value={form.customer_utility_pct}
                onChange={(e) => setCustomerUtility(parseFloat(e.target.value) || 0)}
                disabled={readOnly}
              />
            </div>
            <div className="space-y-1">
              <Label>Generator split % (customer)</Label>
              <Input
                type="number" min={0} max={100} step={0.01}
                value={form.customer_generator_pct}
                onChange={(e) => setForm((f) => ({ ...f, customer_generator_pct: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
              {Math.abs(form.customer_utility_pct + form.customer_generator_pct - 100) > 0.01 && (
                <p className="text-xs text-destructive">Must sum to 100%</p>
              )}
            </div>

            <div className="space-y-1">
              <Label>Markup type</Label>
              <Select
                value={form.markup_type}
                onValueChange={(v) => setForm((f) => ({ ...f, markup_type: v as "per_unit" | "percent" }))}
                disabled={readOnly}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="per_unit">₹ per unit (added to utility rate)</SelectItem>
                  <SelectItem value="percent">% on landlord utility rate</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Markup value</Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.markup_value}
                onChange={(e) => setForm((f) => ({ ...f, markup_value: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
            </div>

            <div className="space-y-1">
              <Label>Customer generator rate (₹/unit)</Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.customer_generator_rate}
                onChange={(e) => setForm((f) => ({ ...f, customer_generator_rate: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
              <p className="text-xs text-muted-foreground">Independent of landlord DG rate</p>
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

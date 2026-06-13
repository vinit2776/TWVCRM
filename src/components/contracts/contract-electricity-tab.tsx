"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Zap, Save, AlertTriangle, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatCurrency } from "@/lib/utils";

interface Location { id: string; name: string; code: string }

interface LocationConfig {
  service_number: string | null;
  landlord_utility_rate: number;
  landlord_generator_rate: number;
  enabled: boolean;
  landlord_utility_pct: number;
  landlord_generator_pct: number;
}

interface ContractElectricityConfig {
  id: string;
  contract_id: string;
  location_id: string;
  enabled: boolean;
  utility_ratio: number;
  generator_ratio: number;
  customer_utility_rate: number;
  customer_generator_rate: number;
  customer_gst_rate: number;
}

interface Props {
  contractId: string;
  /** From the contract record — used to pre-fill GST */
  contractGstRate?: number;
  canEdit: boolean;
}

const DEFAULTS = {
  location_id: "",
  enabled: false,
  utility_ratio: 0,
  generator_ratio: 0,
  customer_utility_rate: 0,
  customer_generator_rate: 0,
  customer_gst_rate: 18,
};

export function ContractElectricityTab({ contractId, contractGstRate = 18, canEdit }: Props) {
  const [cfg, setCfg] = useState<ContractElectricityConfig | null>(null);
  const [locationConfig, setLocationConfig] = useState<LocationConfig | null>(null);
  const [form, setForm] = useState({ ...DEFAULTS, customer_gst_rate: contractGstRate });
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    const [cfgRes, locRes] = await Promise.all([
      fetch(`/api/contracts/${contractId}/electricity-config`),
      fetch(`/api/locations?limit=50`),
    ]);

    if (cfgRes.ok) {
      const json = await cfgRes.json();
      if (json.data) {
        setCfg(json.data);
        setForm({
          location_id: json.data.location_id,
          enabled: json.data.enabled,
          utility_ratio: json.data.utility_ratio,
          generator_ratio: json.data.generator_ratio,
          customer_utility_rate: json.data.customer_utility_rate,
          customer_generator_rate: json.data.customer_generator_rate,
          customer_gst_rate: json.data.customer_gst_rate,
        });
      }
      if (json.locationConfig) setLocationConfig(json.locationConfig);
    }

    if (locRes.ok) {
      const json = await locRes.json();
      setLocations(json.data ?? []);
    }

    setLoading(false);
  }, [contractId]);

  useEffect(() => { fetch_(); }, [fetch_]);

  // When location changes, fetch its config for the reference panel
  const handleLocationChange = async (locId: string) => {
    setForm((f) => ({ ...f, location_id: locId }));
    if (!locId) { setLocationConfig(null); return; }
    const res = await fetch(`/api/locations/${locId}/electricity-config`);
    if (res.ok) {
      const json = await res.json();
      setLocationConfig(json.data ?? null);
    }
  };

  const handleSave = async () => {
    if (!form.location_id) {
      toast.error("Please select a location first");
      return;
    }
    setSaving(true);
    const res = await fetch(`/api/contracts/${contractId}/electricity-config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const json = await res.json();
    if (res.ok) {
      setCfg(json.data);
      toast.success(cfg ? "Electricity settings updated" : "Electricity settings saved");
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
        {[1, 2, 3].map((i) => <div key={i} className="h-20 bg-muted animate-pulse rounded" />)}
      </div>
    );
  }

  const readOnly = !canEdit;

  return (
    <div className="space-y-6">
      {/* Enable + location */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" />
            Electricity Billing
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Bill this contract for electricity</p>
              <p className="text-xs text-muted-foreground">
                Customer will receive an electricity invoice each month after the landlord bill is approved
              </p>
            </div>
            <Switch
              checked={form.enabled}
              onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              disabled={readOnly}
            />
          </div>

          <Separator />

          <div className="space-y-1">
            <Label>Building / Location</Label>
            <Select
              value={form.location_id || "none"}
              onValueChange={(v) => handleLocationChange(v === "none" ? "" : v)}
              disabled={readOnly}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select location…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {locations.map((l) => (
                  <SelectItem key={l.id} value={l.id}>{l.name} ({l.code})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Landlord tariff reference panel */}
          {locationConfig && (
            <div className="rounded-md bg-muted/50 border p-3 text-sm space-y-1">
              <div className="flex items-center justify-between">
                <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">Landlord tariff (reference)</p>
                {!locationConfig.enabled && (
                  <Badge variant="destructive" className="text-xs">EB not enabled</Badge>
                )}
              </div>
              {locationConfig.service_number && (
                <p>Meter: <span className="font-mono text-xs">{locationConfig.service_number}</span></p>
              )}
              <div className="flex gap-6 text-xs text-muted-foreground mt-1">
                <span>Grid: {formatCurrency(locationConfig.landlord_utility_rate)}/unit</span>
                <span>DG: {formatCurrency(locationConfig.landlord_generator_rate)}/unit</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Customer rates below are independent — mark them up as needed.
              </p>
              {form.location_id && (
                <Link
                  href={`/locations/${form.location_id}?tab=electricity`}
                  className="text-xs text-primary flex items-center gap-1 mt-1 w-fit hover:underline"
                >
                  Manage location config <ExternalLink className="h-3 w-3" />
                </Link>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Customer allocation */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer Allocation</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Percentage of the building&apos;s total landlord units this contract is billed for.
            Multiple contracts can be mapped to the same location; ratios are independent.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Grid % of building utility units</Label>
              <div className="relative">
                <Input
                  type="number" min={0} max={100} step={0.01}
                  value={form.utility_ratio}
                  onChange={(e) => setForm((f) => ({ ...f, utility_ratio: parseFloat(e.target.value) || 0 }))}
                  disabled={readOnly}
                  className="pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
              </div>
            </div>
            <div className="space-y-1">
              <Label>DG % of building generator units</Label>
              <div className="relative">
                <Input
                  type="number" min={0} max={100} step={0.01}
                  value={form.generator_ratio}
                  onChange={(e) => setForm((f) => ({ ...f, generator_ratio: parseFloat(e.target.value) || 0 }))}
                  disabled={readOnly}
                  className="pr-8"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">%</span>
              </div>
            </div>
          </div>
          {form.utility_ratio === 0 && form.generator_ratio === 0 && form.enabled && (
            <div className="flex items-center gap-2 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              Both ratios are 0% — this contract will not be billed for any units.
            </div>
          )}
        </CardContent>
      </Card>

      {/* Customer rates */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Customer Rates</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Rates charged to this customer — independent of landlord tariff. Set a markup as needed.
          </p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label>Grid rate (₹/unit)</Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.customer_utility_rate}
                onChange={(e) => setForm((f) => ({ ...f, customer_utility_rate: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
              {locationConfig && form.customer_utility_rate > 0 && (
                <p className="text-xs text-muted-foreground">
                  Markup: {formatCurrency(form.customer_utility_rate - locationConfig.landlord_utility_rate)}/unit
                  ({locationConfig.landlord_utility_rate > 0
                    ? `${(((form.customer_utility_rate / locationConfig.landlord_utility_rate) - 1) * 100).toFixed(1)}%`
                    : "landlord rate not set"})
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>DG rate (₹/unit)</Label>
              <Input
                type="number" min={0} step={0.01}
                value={form.customer_generator_rate}
                onChange={(e) => setForm((f) => ({ ...f, customer_generator_rate: parseFloat(e.target.value) || 0 }))}
                disabled={readOnly}
              />
              {locationConfig && form.customer_generator_rate > 0 && (
                <p className="text-xs text-muted-foreground">
                  Markup: {formatCurrency(form.customer_generator_rate - locationConfig.landlord_generator_rate)}/unit
                </p>
              )}
            </div>
            <div className="space-y-1">
              <Label>GST %</Label>
              <Input
                type="number" min={0} max={28} step={0.01}
                value={form.customer_gst_rate}
                onChange={(e) => setForm((f) => ({ ...f, customer_gst_rate: parseFloat(e.target.value) || 18 }))}
                disabled={readOnly}
              />
              <p className="text-xs text-muted-foreground">Defaults from contract GST rate</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            <Save className="mr-2 h-4 w-4" />
            {saving ? "Saving…" : cfg ? "Update Settings" : "Save Settings"}
          </Button>
        </div>
      )}
    </div>
  );
}

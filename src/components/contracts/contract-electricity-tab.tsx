"use client";

import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
import { Zap, Save, AlertTriangle, ExternalLink } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
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
import { computeCustomerRate } from "@/lib/electricity";

interface Location { id: string; name: string; code: string }

interface LocationConfig {
  service_number: string | null;
  landlord_utility_rate: number;
  landlord_generator_rate: number;
  enabled: boolean;
  landlord_utility_pct: number;
  landlord_generator_pct: number;
}

interface BillingProfile {
  id: string;
  name: string;
  description: string | null;
  customer_utility_pct: number;
  customer_generator_pct: number;
  utility_markup_type: "per_unit" | "percent";
  utility_markup_value: number;
  generator_markup_type: "per_unit" | "percent";
  generator_markup_value: number;
  customer_gst_rate: number;
  is_active: boolean;
}

interface ContractElectricityConfig {
  id: string;
  contract_id: string;
  location_id: string;
  enabled: boolean;
  billing_profile_id: string | null;
  billing_profile?: BillingProfile | null;
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
  billing_profile_id: null as string | null,
};

export function ContractElectricityTab({ contractId, canEdit }: Props) {
  const [cfg, setCfg] = useState<ContractElectricityConfig | null>(null);
  const [locationConfig, setLocationConfig] = useState<LocationConfig | null>(null);
  const [profiles, setProfiles] = useState<BillingProfile[]>([]);
  const [form, setForm] = useState(DEFAULTS);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const fetch_ = useCallback(async () => {
    setLoading(true);
    const [cfgRes, locRes, profilesRes] = await Promise.all([
      fetch(`/api/contracts/${contractId}/electricity-config`),
      fetch(`/api/locations?limit=50`),
      fetch(`/api/admin/electricity-billing-profiles`),
    ]);

    if (cfgRes.ok) {
      const json = await cfgRes.json();
      if (json.data) {
        setCfg(json.data);
        setForm({
          location_id: json.data.location_id,
          enabled: json.data.enabled,
          billing_profile_id: json.data.billing_profile_id ?? null,
        });
      }
      if (json.locationConfig) setLocationConfig(json.locationConfig);
    }

    if (locRes.ok) {
      const json = await locRes.json();
      setLocations(json.data ?? []);
    }

    if (profilesRes.ok) {
      const json = await profilesRes.json();
      setProfiles(json.data ?? []);
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
    // location_id is NOT NULL in the DB — a config can never be saved without
    // one. So picking "— None —" when a config already exists means "remove
    // electricity billing from this contract", not "save with no location".
    if (!form.location_id) {
      if (!cfg) {
        toast.error("Please select a location first");
        return;
      }
      setSaving(true);
      const res = await fetch(`/api/contracts/${contractId}/electricity-config`, { method: "DELETE" });
      if (res.ok) {
        setCfg(null);
        setForm(DEFAULTS);
        setLocationConfig(null);
        toast.success("Electricity billing removed for this contract");
      } else {
        const json = await res.json().catch(() => ({}));
        toast.error(json.error || "Failed to remove electricity settings");
      }
      setSaving(false);
      return;
    }
    if (form.enabled && !form.billing_profile_id) {
      toast.error("Please select a billing profile");
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
  const selectedProfile = profiles.find((p) => p.id === form.billing_profile_id) ?? cfg?.billing_profile ?? null;
  // Profiles the dropdown offers: active ones, plus the currently-assigned one even if deactivated.
  const selectableProfiles = profiles.filter((p) => p.is_active || p.id === form.billing_profile_id);

  const previewUtilityRate = selectedProfile && locationConfig
    ? computeCustomerRate(
        { markup_type: selectedProfile.utility_markup_type, markup_value: selectedProfile.utility_markup_value },
        locationConfig.landlord_utility_rate,
      )
    : null;
  const previewGeneratorRate = selectedProfile && locationConfig
    ? computeCustomerRate(
        { markup_type: selectedProfile.generator_markup_type, markup_value: selectedProfile.generator_markup_value },
        locationConfig.landlord_generator_rate,
      )
    : null;

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
                Reference rates only — the actual customer rate each month is derived from that
                month&apos;s captured landlord bill + the billing profile&apos;s margin.
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

      {/* Billing profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Billing Profile</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            The profile defines how this contract&apos;s units and rate are derived from the
            landlord bill each month — no manual monthly rate entry needed.
          </p>
          <div className="space-y-1">
            <Label>Profile</Label>
            <Select
              value={form.billing_profile_id ?? "none"}
              onValueChange={(v) => setForm((f) => ({ ...f, billing_profile_id: v === "none" ? null : v }))}
              disabled={readOnly}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a billing profile…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— None —</SelectItem>
                {selectableProfiles.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.name}{!p.is_active ? " (inactive)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Link
              href="/admin/electricity-billing-profiles"
              className="text-xs text-primary flex items-center gap-1 mt-1 w-fit hover:underline"
            >
              Manage profiles <ExternalLink className="h-3 w-3" />
            </Link>
          </div>

          {form.enabled && !form.billing_profile_id && (
            <div className="flex items-center gap-2 text-xs text-amber-600">
              <AlertTriangle className="h-3.5 w-3.5" />
              A billing profile is required for electricity billing to run.
            </div>
          )}

          {selectedProfile && (
            <div className="rounded-md bg-muted/50 border p-3 text-sm space-y-2">
              <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
                Resolved split &amp; margin
              </p>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <p className="text-muted-foreground">Customer split</p>
                  <p>{selectedProfile.customer_utility_pct}% utility / {selectedProfile.customer_generator_pct}% DG</p>
                  <p className="text-muted-foreground">of the landlord bill&apos;s total units</p>
                </div>
                <div>
                  <p className="text-muted-foreground">Margin</p>
                  <p>
                    Utility {selectedProfile.utility_markup_type === "per_unit" ? `+${formatCurrency(selectedProfile.utility_markup_value)}/unit` : `+${selectedProfile.utility_markup_value}%`}
                  </p>
                  <p>
                    DG {selectedProfile.generator_markup_type === "per_unit" ? `+${formatCurrency(selectedProfile.generator_markup_value)}/unit` : `+${selectedProfile.generator_markup_value}%`}
                  </p>
                </div>
              </div>
              {previewUtilityRate !== null && previewGeneratorRate !== null && (
                <p className="text-xs text-muted-foreground border-t pt-2">
                  Estimated customer rate at today&apos;s reference landlord tariff:{" "}
                  {formatCurrency(previewUtilityRate)}/unit utility, {formatCurrency(previewGeneratorRate)}/unit DG.
                  Actual rate each month uses that bill&apos;s captured landlord rate, not this reference.
                </p>
              )}
              <p className="text-xs text-muted-foreground">GST on customer invoice: {selectedProfile.customer_gst_rate}%</p>
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit && (
        <div className="flex justify-end">
          <Button
            onClick={handleSave}
            disabled={saving}
            variant={!form.location_id && cfg ? "destructive" : "default"}
          >
            <Save className="mr-2 h-4 w-4" />
            {saving
              ? (!form.location_id && cfg ? "Removing…" : "Saving…")
              : !form.location_id && cfg ? "Remove Electricity Billing" : cfg ? "Update Settings" : "Save Settings"}
          </Button>
        </div>
      )}
    </div>
  );
}

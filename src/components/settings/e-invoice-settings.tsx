"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  Loader2, FileText, CheckCircle2, XCircle, AlertTriangle,
  PlayCircle, RefreshCw,
} from "lucide-react";

interface PublicConfig {
  enabled: boolean;
  environment: "sandbox" | "production";
  irp_provider: string;
  seller_gstin: string;
  seller_legal_name: string;
  seller_trade_name: string;
  seller_address1: string;
  seller_address2: string;
  seller_location: string;
  seller_pincode: string;
  seller_state_code: string;
  default_sac_code: string;
  default_gst_rate: number;
  go_live_date: string;
  daily_batch_enabled: boolean;
  daily_batch_hour_ist: number;
  last_successful_auth_at: string | null;
  cached_token_expires_at: string | null;
}

interface AuthTestResult {
  ok: boolean;
  provider?: string;
  environment?: string;
  token_expires_at?: string;
  latency_ms?: number;
  error_code?: string;
  error_message?: string;
}

export function EInvoiceSettings() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastResult, setLastResult] = useState<AuthTestResult | null>(null);

  const fetchConfig = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/e-invoice/settings");
      if (!res.ok) throw new Error("Failed to load");
      const data = await res.json();
      setConfig(data);
    } catch {
      toast.error("Failed to load e-invoice settings");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchConfig(); }, []);

  const handleSave = async () => {
    if (!config) return;
    setSaving(true);
    try {
      const res = await fetch("/api/e-invoice/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to save");
      } else {
        toast.success("E-Invoice settings saved");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setLastResult(null);
    try {
      const res = await fetch("/api/e-invoice/auth-test", { method: "POST" });
      const data: AuthTestResult = await res.json();
      setLastResult(data);
      if (data.ok) {
        toast.success(`Connected to ${data.provider} ${data.environment} (${data.latency_ms}ms)`);
        await fetchConfig(); // refresh last_successful_auth_at
      } else {
        toast.error(`Auth failed: ${data.error_message || data.error_code || "Unknown"}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setLastResult({ ok: false, error_message: msg });
      toast.error(`Network error: ${msg}`);
    } finally {
      setTesting(false);
    }
  };

  const handleSyncGstin = async () => {
    if (!config?.seller_gstin) {
      toast.error("Set seller GSTIN first");
      return;
    }
    setTesting(true);
    try {
      const res = await fetch("/api/e-invoice/sync-seller-gstin", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "GSTIN sync failed");
      } else {
        toast.success("Seller details fetched from IRP");
        await fetchConfig();
      }
    } finally {
      setTesting(false);
    }
  };

  if (loading || !config) {
    return (
      <Card>
        <CardContent className="py-12 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const update = <K extends keyof PublicConfig>(k: K, v: PublicConfig[K]) =>
    setConfig({ ...config, [k]: v });

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <FileText className="h-4 w-4" />
            GST E-Invoicing Configuration
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <p className="text-sm text-muted-foreground">
            Configure GST e-invoicing per NIC v1.1 spec. Tax invoices for B2B buyers
            (with GSTIN) will be registered with the configured IRP for IRN generation.
          </p>

          {/* ── Status banner ──────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 p-3 rounded-lg border bg-muted/30">
            <Badge variant={config.enabled ? "default" : "secondary"} className="text-xs">
              {config.enabled ? "Enabled" : "Disabled"}
            </Badge>
            <Badge variant="outline" className="text-xs uppercase">
              {config.environment}
            </Badge>
            <Badge variant="outline" className="text-xs uppercase">
              {config.irp_provider === "einvoice6" ? "IRIS IRP6" : config.irp_provider}
            </Badge>
            <span className="text-xs text-muted-foreground ml-auto">
              Go-live: {config.go_live_date}
            </span>
          </div>

          {/* ── Test Connection ──────────────────────────────── */}
          <div className="rounded-lg border p-4 space-y-3 bg-blue-50/30">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold flex items-center gap-1.5">
                  <PlayCircle className="h-4 w-4 text-blue-600" />
                  Test Connection
                </h3>
                <p className="text-xs text-muted-foreground mt-1">
                  Performs a fresh auth round-trip with {config.irp_provider} {config.environment}.
                  Confirms credentials, public-key encryption, and SEK decryption all work.
                </p>
              </div>
              <Button
                onClick={handleTestConnection}
                disabled={testing}
                size="sm"
                className="shrink-0"
              >
                {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
                {testing ? "Testing..." : "Run Test"}
              </Button>
            </div>

            {lastResult && (
              <div className={`text-xs p-3 rounded border ${
                lastResult.ok
                  ? "bg-green-50 border-green-200"
                  : "bg-red-50 border-red-200"
              }`}>
                {lastResult.ok ? (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-green-800">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Authentication successful
                    </div>
                    <div className="text-green-700 ml-5">
                      <p>Provider: <span className="font-mono">{lastResult.provider}</span></p>
                      <p>Environment: <span className="font-mono">{lastResult.environment}</span></p>
                      <p>Token expires: <span className="font-mono">{lastResult.token_expires_at && new Date(lastResult.token_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span></p>
                      <p>Latency: <span className="font-mono">{lastResult.latency_ms}ms</span></p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-red-800">
                      <XCircle className="h-3.5 w-3.5" /> Authentication failed
                    </div>
                    <div className="text-red-700 ml-5">
                      {lastResult.error_code && (
                        <p>Code: <span className="font-mono">{lastResult.error_code}</span></p>
                      )}
                      {lastResult.error_message && (
                        <p>Message: {lastResult.error_message}</p>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {config.last_successful_auth_at && (
              <p className="text-[11px] text-muted-foreground">
                Last successful auth: {new Date(config.last_successful_auth_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                {config.cached_token_expires_at && (
                  <> · Token cached until {new Date(config.cached_token_expires_at).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })}</>
                )}
              </p>
            )}
          </div>

          {/* ── Seller details ────────────────────────────────── */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Seller Details</h3>
              <Button
                variant="outline"
                size="sm"
                onClick={handleSyncGstin}
                disabled={testing || !config.seller_gstin}
                title="Auto-fill from IRP's GSTIN Master API"
              >
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Sync from IRP
              </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="gstin">GSTIN <span className="text-red-500">*</span></Label>
                <Input
                  id="gstin"
                  value={config.seller_gstin}
                  onChange={(e) => update("seller_gstin", e.target.value.toUpperCase())}
                  className="font-mono"
                  placeholder="33AAACU4245J1ZF"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="state_code">State Code</Label>
                <Input
                  id="state_code"
                  value={config.seller_state_code}
                  disabled
                  className="font-mono bg-muted"
                />
                <p className="text-[10px] text-muted-foreground">Auto-derived from GSTIN</p>
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>Legal Name <span className="text-red-500">*</span></Label>
                <Input
                  value={config.seller_legal_name}
                  onChange={(e) => update("seller_legal_name", e.target.value)}
                  placeholder="As registered with GST"
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>Trade Name (optional)</Label>
                <Input
                  value={config.seller_trade_name}
                  onChange={(e) => update("seller_trade_name", e.target.value)}
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>Address Line 1 <span className="text-red-500">*</span></Label>
                <Input
                  value={config.seller_address1}
                  onChange={(e) => update("seller_address1", e.target.value)}
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label>Address Line 2</Label>
                <Input
                  value={config.seller_address2}
                  onChange={(e) => update("seller_address2", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Location / City <span className="text-red-500">*</span></Label>
                <Input
                  value={config.seller_location}
                  onChange={(e) => update("seller_location", e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Pincode <span className="text-red-500">*</span></Label>
                <Input
                  value={config.seller_pincode}
                  onChange={(e) => update("seller_pincode", e.target.value)}
                  className="font-mono"
                  maxLength={6}
                />
              </div>
            </div>
          </div>

          {/* ── Defaults ──────────────────────────────────────── */}
          <div className="space-y-3 pt-3 border-t">
            <h3 className="text-sm font-semibold">Defaults for Co-Working Invoices</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label>Default SAC Code</Label>
                <Input
                  value={config.default_sac_code}
                  onChange={(e) => update("default_sac_code", e.target.value)}
                  className="font-mono"
                />
                <p className="text-[10px] text-muted-foreground">997212 = Co-working / non-residential rental</p>
              </div>
              <div className="space-y-1.5">
                <Label>Default GST Rate (%)</Label>
                <Input
                  type="number"
                  step="0.01"
                  value={config.default_gst_rate}
                  onChange={(e) => update("default_gst_rate", parseFloat(e.target.value) || 0)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Go-Live Date</Label>
                <Input
                  type="date"
                  value={config.go_live_date}
                  onChange={(e) => update("go_live_date", e.target.value)}
                />
                <p className="text-[10px] text-muted-foreground">Invoices before this date skip IRN</p>
              </div>
            </div>
          </div>

          {/* ── Daily Batch ───────────────────────────────────── */}
          <div className="space-y-3 pt-3 border-t">
            <h3 className="text-sm font-semibold">End-of-Day Batch</h3>
            <div className="flex items-center gap-3">
              <input
                id="batch_enabled"
                type="checkbox"
                checked={config.daily_batch_enabled}
                onChange={(e) => update("daily_batch_enabled", e.target.checked)}
                className="h-4 w-4"
              />
              <Label htmlFor="batch_enabled" className="cursor-pointer">
                Run daily batch to generate IRNs for the day&apos;s tax invoices
              </Label>
            </div>
            {config.daily_batch_enabled && (
              <div className="space-y-1.5 max-w-[200px]">
                <Label>Hour (IST, 24-hr)</Label>
                <Input
                  type="number"
                  min={0}
                  max={23}
                  value={config.daily_batch_hour_ist}
                  onChange={(e) => update("daily_batch_hour_ist", parseInt(e.target.value, 10) || 23)}
                />
              </div>
            )}
          </div>

          {/* ── Enable toggle ─────────────────────────────────── */}
          <div className="space-y-3 pt-3 border-t">
            <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 border border-amber-200">
              <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-800 space-y-1">
                <p className="font-semibold">Before enabling:</p>
                <ol className="list-decimal ml-4 space-y-0.5">
                  <li>Run a successful Test Connection above</li>
                  <li>Verify all seller details are correct</li>
                  <li>Confirm go-live date — only invoices on/after this date will get IRN</li>
                </ol>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input
                id="enabled"
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => update("enabled", e.target.checked)}
                className="h-4 w-4"
              />
              <Label htmlFor="enabled" className="cursor-pointer font-semibold">
                Enable e-invoicing
              </Label>
            </div>
          </div>

          {/* ── Save ──────────────────────────────────────────── */}
          <div className="flex justify-end pt-3 border-t">
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />}
              {saving ? "Saving..." : "Save Configuration"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

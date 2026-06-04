"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FileText, Building2, Clock, CheckCircle2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type GstMode = "crm" | "tally" | "standby";

interface ModeOption {
  id: GstMode;
  label: string;
  description: string;
  icon: React.ReactNode;
  badge?: string;
  badgeVariant?: "default" | "secondary" | "outline";
}

const MODES: ModeOption[] = [
  {
    id: "crm",
    label: "CRM GST",
    description: "CRM issues GST invoice number, generates PDF, and emails the customer after payment.",
    icon: <FileText className="h-5 w-5" />,
    badge: "Current system",
    badgeVariant: "outline",
  },
  {
    id: "standby",
    label: "Standby",
    description: "Payments are recorded. No GST invoice is issued by CRM or Tally. Use this during transition.",
    icon: <Clock className="h-5 w-5" />,
    badge: "Transition mode",
    badgeVariant: "secondary",
  },
  {
    id: "tally",
    label: "Tally Sync",
    description: "Tally issues the GST invoice, applies IRN if eligible, and sends the customer the invoice + fresh payment link.",
    icon: <Building2 className="h-5 w-5" />,
    badge: "New system",
    badgeVariant: "default",
  },
];

export function GstInvoiceModeSettings() {
  const [mode, setMode] = useState<GstMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/settings/public");
        if (!res.ok) return;
        const json = await res.json() as { data: Record<string, string> };
        const crm = json.data["crm_gst_enabled"] === "true";
        const tally = json.data["tally_sync_enabled"] === "true";
        if (crm) setMode("crm");
        else if (tally) setMode("tally");
        else setMode("standby");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  async function handleSelect(next: GstMode) {
    if (next === mode || saving) return;
    setSaving(true);
    try {
      const crmOn = next === "crm";
      const tallyOn = next === "tally";

      // Update crm_gst_enabled via /api/settings
      const settingsRes = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ crm_gst_enabled: String(crmOn) }),
      });
      if (!settingsRes.ok) {
        const err = await settingsRes.json() as { error?: string };
        toast.error(err.error ?? "Failed to update CRM GST setting");
        return;
      }

      // Update tally_sync_enabled via /api/tally/control
      const tallyRes = await fetch("/api/tally/control", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: tallyOn ? "resume" : "pause", reason: tallyOn ? "" : "GST mode switched" }),
      });
      if (!tallyRes.ok) {
        const err = await tallyRes.json() as { error?: string };
        toast.error(err.error ?? "Failed to update Tally Sync setting");
        return;
      }

      setMode(next);
      toast.success(
        next === "crm" ? "CRM GST mode activated"
          : next === "tally" ? "Tally Sync mode activated"
          : "GST invoicing set to standby",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">GST Invoice Mode</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center justify-between">
          <span>GST Invoice Mode</span>
          {mode && (
            <Badge variant={mode === "standby" ? "secondary" : "default"}>
              {mode === "crm" ? "CRM Active" : mode === "tally" ? "Tally Active" : "Standby"}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Controls which system issues GST invoices. Only one can be active at a time.
          Payments are always recorded regardless of this setting.
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          {MODES.map((m) => {
            const isSelected = mode === m.id;
            return (
              <button
                key={m.id}
                type="button"
                disabled={saving}
                onClick={() => void handleSelect(m.id)}
                className={cn(
                  "relative flex flex-col items-start gap-2 rounded-lg border p-4 text-left transition-colors",
                  isSelected
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-border hover:border-muted-foreground/40 hover:bg-muted/30",
                  saving && "cursor-not-allowed opacity-60",
                )}
              >
                {isSelected && (
                  <CheckCircle2 className="absolute right-3 top-3 h-4 w-4 text-primary" />
                )}
                <div className={cn("rounded-md p-1.5", isSelected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                  {m.icon}
                </div>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{m.label}</span>
                    {m.badge && (
                      <Badge variant={m.badgeVariant ?? "outline"} className="text-[10px] px-1.5 py-0">
                        {m.badge}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{m.description}</p>
                </div>
              </button>
            );
          })}
        </div>
        {saving && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Saving…
          </div>
        )}
        {mode === "standby" && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <strong>Standby active.</strong> GST invoices will not be issued automatically. Payments are recorded and will be invoiced once you activate CRM GST or Tally Sync.
          </div>
        )}
        {mode === "tally" && (
          <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-800">
            <strong>Tally Sync active.</strong> All GST invoice issuance is handled by Tally. Ensure the bridge is online and the correct company is open in Tally before processing invoices.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Compact version without the full card — for embedding in the Tally Sync page
export function GstModeSwitchButton() {
  return (
    <div className="text-xs text-muted-foreground">
      GST mode is controlled from{" "}
      <a href="/settings?tab=integrations" className="underline text-primary">
        Settings → Integrations
      </a>
      .
    </div>
  );
}

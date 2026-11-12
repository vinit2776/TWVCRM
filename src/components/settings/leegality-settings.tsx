"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PenLine, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function LeegalitySettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({ leegality_enabled: "true" });

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const json = await res.json();
          const data = json.data as { key: string; value: string }[];
          const row = data.find((s) => s.key === "leegality_enabled");
          if (row) setSettings({ leegality_enabled: row.value });
        }
      } catch { /* ignore */ }
      setLoading(false);
    };
    fetchSettings();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      if (res.ok) {
        toast.success("E-signing settings saved");
      } else {
        const err = await res.json().catch(() => null);
        toast.error(err?.error || "Failed to save settings");
      }
    } catch {
      toast.error("Failed to save settings");
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardContent className="py-8">
          <div className="flex items-center justify-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading settings...
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <PenLine className="h-4 w-4" />
          E-Signing (Leegality)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Enable Leegality e-signing</Label>
            <p className="text-xs text-muted-foreground max-w-md">
              Controls the &quot;Send for e-Signing&quot; button on contracts and Leave &amp; License
              agreements. Turning this off only blocks starting a <em>new</em> signing request —
              it never touches one already in progress; use &quot;Cancel e-Signing Request&quot; on a
              contract to withdraw a specific one. Company stamp and manual document upload
              stay available either way.
            </p>
          </div>
          <Switch
            checked={settings.leegality_enabled !== "false"}
            onCheckedChange={(checked) =>
              setSettings({ leegality_enabled: checked ? "true" : "false" })
            }
          />
        </div>

        {settings.leegality_enabled === "false" && (
          <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <strong>E-signing is off.</strong> Staff will see the e-signing button disabled
            everywhere it appears. Use company stamp or upload a manually signed document instead.
          </div>
        )}

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save E-Signing Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

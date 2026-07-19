"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Sparkles, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function FacilityClassifierSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [settings, setSettings] = useState({
    facility_classifier_ui_enabled: "false",
    facility_category_autofill_enabled: "false",
  });

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const json = await res.json();
          const data = json.data as { key: string; value: string }[];
          const map: Record<string, string> = {};
          data.forEach((s) => { map[s.key] = s.value; });
          setSettings((prev) => ({ ...prev, ...map }));
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
        toast.success("Facility classifier settings saved");
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
          <Sparkles className="h-4 w-4" />
          Facility Classifier
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Show suggestions in Work Order wizard</Label>
            <p className="text-xs text-muted-foreground max-w-md">
              Pre-selects a department based on the title/description, with a &quot;matched
              &apos;...&apos;&quot; receipt. Reporters can always tap a different department —
              this never blocks submission. Leave off until Phase 4&apos;s shadow-mode telemetry
              (recorded regardless of this flag) shows the suggestions agree with how tickets
              actually resolved.
            </p>
          </div>
          <Switch
            checked={settings.facility_classifier_ui_enabled === "true"}
            onCheckedChange={(checked) =>
              setSettings((prev) => ({ ...prev, facility_classifier_ui_enabled: checked ? "true" : "false" }))
            }
          />
        </div>

        <Separator />

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm font-medium">Auto-fill category from suggestion</Label>
            <p className="text-xs text-muted-foreground max-w-md">
              Populates the ticket&apos;s category (currently always left blank) from the
              classifier&apos;s suggestion. This activates each category&apos;s
              default-assignee routing in Facility Settings — a real change in who gets
              auto-assigned, separate from the suggestion UI above.
            </p>
          </div>
          <Switch
            checked={settings.facility_category_autofill_enabled === "true"}
            onCheckedChange={(checked) =>
              setSettings((prev) => ({ ...prev, facility_category_autofill_enabled: checked ? "true" : "false" }))
            }
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Classifier Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

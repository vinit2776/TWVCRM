"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CalendarClock, Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  DEFAULT_RENEWAL_GRACE_DAYS,
  MAX_RENEWAL_GRACE_DAYS,
  VO_RENEWAL_GRACE_DAYS_SETTING,
  parseGraceDays,
} from "@/lib/vo-renewal-desk";

export function VoRenewalSettings() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [graceDays, setGraceDays] = useState(String(DEFAULT_RENEWAL_GRACE_DAYS));

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const res = await fetch("/api/settings");
        if (res.ok) {
          const json = await res.json();
          const data = json.data as { key: string; value: string }[];
          const row = data.find((s) => s.key === VO_RENEWAL_GRACE_DAYS_SETTING);
          setGraceDays(String(parseGraceDays(row?.value)));
        }
      } catch { /* ignore */ }
      setLoading(false);
    };
    fetchSettings();
  }, []);

  const n = Number(graceDays);
  const valid = Number.isInteger(n) && n >= 1 && n <= MAX_RENEWAL_GRACE_DAYS;

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [VO_RENEWAL_GRACE_DAYS_SETTING]: String(n) }),
      });
      if (res.ok) {
        toast.success("Virtual office settings saved");
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
          <CalendarClock className="h-4 w-4" />
          Virtual Office renewals
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="vo-grace-days" className="text-sm font-medium">Grace period (days)</Label>
          <Input
            id="vo-grace-days"
            type="number"
            min={1}
            max={MAX_RENEWAL_GRACE_DAYS}
            value={graceDays}
            onChange={(e) => setGraceDays(e.target.value)}
            className="w-32"
          />
          <p className="text-xs text-muted-foreground max-w-md">
            How long a Virtual Office case stays &quot;In grace&quot; after its end date before it
            shows as Lapsed on the Renewals desk and needs a decision. Changing it applies to every
            case without its own date; a case someone gave more time keeps the date they chose.
          </p>
          {!valid && (
            <p className="text-xs text-destructive">Enter a whole number from 1 to {MAX_RENEWAL_GRACE_DAYS}.</p>
          )}
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving || !valid}>
            {saving ? "Saving..." : "Save Virtual Office Settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

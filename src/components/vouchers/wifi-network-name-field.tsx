"use client";

import { useEffect, useState } from "react";
import { Wifi, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DEFAULT_WIFI_SSID } from "@/lib/voucher-email";

interface Props {
  locationId: string;
  locationName: string;
  /** The saved name, or null/empty for the standard one. */
  value: string | null | undefined;
  canEdit: boolean;
  onSaved: () => void;
}

/**
 * The WiFi network name the voucher email tells members to join, per location.
 * Result and errors show beside the Save button, not in a toast.
 */
export function WifiNetworkNameField({ locationId, locationName, value, canEdit, onSaved }: Props) {
  const saved = value?.trim() || DEFAULT_WIFI_SSID;
  const [draft, setDraft] = useState(saved);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { setDraft(saved); setMessage(null); }, [saved, locationId]);

  const dirty = draft.trim() !== saved;

  async function save() {
    setSaving(true);
    setMessage(null);
    try {
      // Saving the standard name stores nothing, so the location follows the default if it ever changes.
      const next = draft.trim();
      const res = await fetch(`/api/locations/${locationId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wifi_ssid: !next || next === DEFAULT_WIFI_SSID ? null : next }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ ok: false, text: json.error ?? "Could not save the network name" });
        return;
      }
      setMessage({ ok: true, text: "Saved" });
      onSaved();
    } catch {
      setMessage({ ok: false, text: "Could not save the network name — check your connection and try again." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm">
      <Wifi className="h-4 w-4 text-primary" />
      <label htmlFor="wifi-ssid" className="font-medium">WiFi network name</label>
      <span className="text-xs text-muted-foreground">shown in voucher emails for {locationName}</span>
      <Input
        id="wifi-ssid"
        value={draft}
        maxLength={32}
        disabled={!canEdit || saving}
        onChange={(e) => { setDraft(e.target.value); setMessage(null); }}
        placeholder={DEFAULT_WIFI_SSID}
        className="h-8 w-56 text-sm"
      />
      {canEdit && (
        <Button size="sm" className="h-8" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Save"}
        </Button>
      )}
      {message && (
        <span role={message.ok ? "status" : "alert"} className={`text-xs ${message.ok ? "text-green-700" : "text-red-600"}`}>
          {message.text}
        </span>
      )}
    </div>
  );
}

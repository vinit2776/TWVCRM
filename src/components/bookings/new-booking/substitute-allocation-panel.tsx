"use client";

/**
 * Lets staff attribute a contract-holder booking's hour-based quota to a
 * different contract_facilities row than the one that would be auto-matched
 * by room name — e.g. a customer given a cabin instead of the (occupied)
 * conference room should still draw down the Conference Room quota instead
 * of silently consuming none. See migration 00553 and
 * maybePostPooledUsageCharge in bookings/[id]/route.ts.
 *
 * Hidden entirely for roles that can't use it (canOverrideBookingFacility) —
 * the server enforces the same gate independently, this just avoids showing
 * a control that would 403.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { canOverrideBookingFacility } from "@/lib/constants";

interface HourFacility {
  id: string;
  name: string;
  unit: string;
  free_quota: number;
  cost_per_unit: number;
  hours_used_this_month: number;
}

interface Props {
  contractId: string;
  spaceName: string;
  facilityId: string;
  reason: string;
  onChange: (next: { facilityId: string; reason: string }) => void;
}

const HOUR_UNITS = ["hr", "hrs", "hour", "hours", "h"];

export function SubstituteAllocationPanel({ contractId, spaceName, facilityId, reason, onChange }: Props) {
  const [allowed, setAllowed] = useState(false);
  const [roleLoaded, setRoleLoaded] = useState(false);
  const [on, setOn] = useState(false);
  const [facilities, setFacilities] = useState<HourFacility[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then((me) => setAllowed(canOverrideBookingFacility(me.role)))
      .catch(() => setAllowed(false))
      .finally(() => setRoleLoaded(true));
  }, []);

  useEffect(() => {
    if (!on || !contractId) { setFacilities([]); return; }
    setLoading(true);
    fetch(`/api/contracts/${contractId}/facilities`)
      .then((r) => r.json())
      .then((j) => setFacilities((j.data || []).filter((f: HourFacility) => HOUR_UNITS.includes(f.unit.toLowerCase()))))
      .catch(() => setFacilities([]))
      .finally(() => setLoading(false));
  }, [on, contractId]);

  if (!roleLoaded || !allowed) return null;

  const selected = facilities.find((f) => f.id === facilityId);

  return (
    <div className="space-y-3">
      <div className={`flex items-start gap-3 rounded-lg border border-dashed px-3.5 py-3 ${on ? "border-primary bg-secondary" : "bg-muted/30"}`}>
        <Switch
          checked={on}
          onCheckedChange={(checked) => {
            setOn(checked);
            if (!checked) onChange({ facilityId: "", reason: "" });
          }}
          className="mt-0.5"
        />
        <div className="flex-1">
          <p className="text-sm font-medium">This room is standing in for a different facility</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Use when the customer&apos;s actual room was unavailable and this booking should count against that facility&apos;s quota instead of {spaceName || "the selected room"}.
          </p>
        </div>
      </div>

      {on && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-amber-800">
            <AlertTriangle className="h-3.5 w-3.5" />
            Substitute allocation
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Count this booking against <span className="text-amber-600">*</span></Label>
            {loading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading facility quotas…
              </div>
            ) : facilities.length === 0 ? (
              <p className="text-xs text-muted-foreground py-1">
                This contract has no hourly facility quota configured — nothing to substitute against.
              </p>
            ) : (
              <Select value={facilityId} onValueChange={(v) => onChange({ facilityId: v, reason })}>
                <SelectTrigger className="bg-background"><SelectValue placeholder="Select facility quota" /></SelectTrigger>
                <SelectContent>
                  {facilities.map((f) => {
                    const remaining = Math.max(0, Number(f.free_quota) - Number(f.hours_used_this_month || 0));
                    return (
                      <SelectItem key={f.id} value={f.id}>
                        {f.name} — {f.free_quota} {f.unit}/mo ({f.hours_used_this_month || 0} used, {remaining} left)
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Reason <span className="text-amber-600">*</span></Label>
            <Textarea
              className="bg-background text-sm"
              placeholder="e.g. Conference Room double-booked by a walk-in 2–4pm — moved to this room"
              value={reason}
              onChange={(e) => onChange({ facilityId, reason: e.target.value })}
              rows={2}
            />
            <p className="text-[11px] text-muted-foreground">
              Logged to the audit trail with your name and timestamp. Visible to Accounts on the billing statement.
            </p>
          </div>

          {selected && (
            <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2.5 text-xs">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                <div>
                  <div className="font-medium text-foreground flex items-center gap-2 flex-wrap">
                    {selected.name} quota
                    <Badge variant="outline" className="text-[10px] bg-purple-50 text-purple-700 border-purple-200">
                      Substitute · {spaceName || "this room"}
                    </Badge>
                  </div>
                  <div className="mt-1 text-muted-foreground">
                    This booking will pool against {selected.name} at checkout, same as if it had been booked there directly.
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { DEFAULT_PROPOSAL_TERMS } from "@/lib/constants";
import { PROPOSAL_MAX_TENURE_MONTHS, maxNoticePeriodMonths } from "@/lib/proposal-terms";
import { MAX_PROPOSAL_TERMS_LENGTH, MAX_SECURITY_DEPOSIT_MONTHS, type ProposalDefaults } from "@/lib/location-proposal-settings";

interface LocationProposalsTabProps {
  locationId: string;
  canEdit: boolean;
  initialTerms?: string | null;
  initialDefaults?: ProposalDefaults | null;
  onSaved: () => void;
}

const NONE = "none";
const monthLabel = (m: number) => `${m} month${m !== 1 ? "s" : ""}`;

export function LocationProposalsTab({ locationId, canEdit, initialTerms, initialDefaults, onSaved }: LocationProposalsTabProps) {
  const [terms, setTerms] = useState(initialTerms ?? "");
  const [tenure, setTenure] = useState<number | null>(initialDefaults?.tenure_months ?? null);
  const [lockIn, setLockIn] = useState<number | null>(initialDefaults?.lock_in_months ?? null);
  const [notice, setNotice] = useState<number | null>(initialDefaults?.notice_period_months ?? null);
  const [deposit, setDeposit] = useState<number | null>(initialDefaults?.security_deposit_months ?? null);
  const [validDays, setValidDays] = useState(initialDefaults?.valid_days != null ? String(initialDefaults.valid_days) : "");
  const [saving, setSaving] = useState(false);

  const maxNotice = tenure != null && lockIn != null ? maxNoticePeriodMonths(tenure, lockIn) : null;

  const handleTenure = (v: string) => {
    const t = v === NONE ? null : parseInt(v);
    setTenure(t);
    if (t == null) { setLockIn(null); setNotice(null); return; }
    const l = lockIn != null ? Math.min(lockIn, t) : null;
    setLockIn(l);
    if (l != null && notice != null) setNotice(Math.min(notice, maxNoticePeriodMonths(t, l)));
  };

  const handleLockIn = (v: string) => {
    const l = v === NONE ? null : parseInt(v);
    setLockIn(l);
    if (l == null) { setNotice(null); return; }
    if (tenure != null && notice != null) setNotice(Math.min(notice, maxNoticePeriodMonths(tenure, l)));
  };

  const save = async () => {
    const days = validDays.trim() ? parseInt(validDays) : null;
    if (days !== null && (!Number.isInteger(days) || days < 1)) { toast.error("Validity must be a whole number of days"); return; }
    setSaving(true);
    const res = await fetch(`/api/locations/${locationId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proposal_terms: terms.trim() ? terms : null,
        proposal_defaults: {
          tenure_months: tenure,
          lock_in_months: lockIn,
          notice_period_months: notice,
          security_deposit_months: deposit,
          valid_days: days,
        },
      }),
    });
    setSaving(false);
    if (res.ok) { toast.success("Proposal settings saved"); onSaved(); }
    else { const err = await res.json().catch(() => ({})); toast.error(err.error || "Failed to save proposal settings"); }
  };

  const optionalSelect = (id: string, label: string, value: number | null, onChange: (v: string) => void, options: number[], disabled = false, placeholder = "Not set") => (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value != null ? String(value) : NONE} onValueChange={onChange} disabled={!canEdit || disabled}>
        <SelectTrigger id={id}><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{placeholder}</SelectItem>
          {options.map((m) => <SelectItem key={m} value={String(m)}>{monthLabel(m)}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Proposal Terms & Conditions</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            New proposals for this location start with this text. Leave it empty to use the standard terms. Existing proposals keep the text they were created with.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <Textarea
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            rows={10}
            maxLength={MAX_PROPOSAL_TERMS_LENGTH}
            disabled={!canEdit}
            placeholder={DEFAULT_PROPOSAL_TERMS}
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              Don&apos;t add lock-in, notice period or security deposit lines — those are generated from the commitment fields on each proposal.
            </p>
            {canEdit && (
              <Button type="button" variant="outline" size="sm" onClick={() => setTerms(DEFAULT_PROPOSAL_TERMS)}>
                Start from standard terms
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Proposal Defaults</CardTitle>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pre-filled on new proposals for this location. The sales rep can still change every value per proposal.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {optionalSelect("def-tenure", "Term", tenure, handleTenure, Array.from({ length: PROPOSAL_MAX_TENURE_MONTHS }, (_, i) => i + 1))}
            {optionalSelect("def-lock-in", "Lock-in period", lockIn, handleLockIn, Array.from({ length: tenure ?? 0 }, (_, i) => i + 1), tenure == null, tenure == null ? "Set term first" : "Not set")}
            {optionalSelect("def-notice", "Notice period", notice, (v) => setNotice(v === NONE ? null : parseInt(v)), Array.from({ length: (maxNotice ?? -1) + 1 }, (_, i) => i), maxNotice == null, maxNotice == null ? "Set lock-in first" : "Not set")}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {optionalSelect("def-deposit", "Security deposit", deposit, (v) => setDeposit(v === NONE ? null : parseInt(v)), Array.from({ length: MAX_SECURITY_DEPOSIT_MONTHS }, (_, i) => i + 1))}
            <div className="space-y-2">
              <Label htmlFor="def-valid-days" className="text-xs text-muted-foreground">Proposal valid for (days)</Label>
              <Input
                id="def-valid-days"
                type="number"
                min={1}
                value={validDays}
                onChange={(e) => setValidDays(e.target.value)}
                disabled={!canEdit}
                placeholder="Not set"
              />
            </div>
          </div>
          {canEdit && (
            <div className="flex justify-end">
              <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving…" : "Save Proposal Settings"}</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import {
  CheckCircle2,
  Fingerprint,
  CreditCard,
  Loader2,
  Send,
  SkipForward,
  DoorOpen,
  RefreshCw,
  ShieldCheck,
  Wifi,
  Circle,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────

interface WizardEntry {
  id: string;
  entity_id: string;
  user_type: string;
  cosec_ref_id: number;
  enrollment_status: string;
  access_pin: string | null;
  nfc_card_number: string | null;
  provisioned_at: string | null;
  biometric_enrolled_at: string | null;
  card_enrolled_at: string | null;
  device_id: string;
  device_label: string;
  entity_name: string | null;
  phone: string | null;
  first_access_at: string | null;
  last_seen_at: string | null;
  is_inside: boolean | null;
}

// Group entries by entity_id so each person has one card (possibly multi-device)
interface PersonGroup {
  entity_id: string;
  user_type: string;
  entity_name: string | null;
  phone: string | null;
  // best enrollment status across all their devices
  bestStatus: string;
  biometric_enrolled_at: string | null;
  nfc_card_number: string | null;
  access_pin: string | null;
  first_access_at: string | null;
  is_inside: boolean | null;
  last_seen_at: string | null;
  // primary entry (first device) — used for card scan
  primaryEntry: WizardEntry;
  allEntries: WizardEntry[];
}

// ── Step helpers ──────────────────────────────────────────────────────────────

const STATUS_RANK: Record<string, number> = {
  fully_enrolled: 4,
  biometric_enrolled: 3,
  card_enrolled: 3,
  provisioned: 2,
  pending_enrollment: 1,
  pending: 1,
};

function bestEnrollmentStatus(entries: WizardEntry[]): string {
  return entries.reduce((best, e) => {
    return (STATUS_RANK[e.enrollment_status] ?? 0) >
      (STATUS_RANK[best] ?? 0)
      ? e.enrollment_status
      : best;
  }, "pending");
}

/**
 * Returns the wizard step number the person is currently on.
 * 1 = Provisioned (always done if record exists)
 * 2 = Fingerprint enrollment
 * 3 = NFC card assignment (optional — can be skipped)
 * 4 = First access verified
 * 5 = All complete
 */
function currentStep(group: PersonGroup, cardSkipped: boolean): number {
  const biometricDone =
    !!group.biometric_enrolled_at ||
    ["biometric_enrolled", "fully_enrolled", "card_enrolled"].includes(
      group.bestStatus
    );
  const cardDone = !!group.nfc_card_number;
  const accessDone = !!group.first_access_at;

  if (!biometricDone) return 2;
  if (!cardDone && !cardSkipped) return 3;
  if (!accessDone) return 4;
  return 5;
}

// ── Step indicator ────────────────────────────────────────────────────────────

const STEPS = [
  { label: "Provisioned", short: "Created" },
  { label: "Fingerprint", short: "Biometric" },
  { label: "Card", short: "NFC Card" },
  { label: "Verified", short: "Active" },
];

function StepBar({
  active,
  skipped,
}: {
  active: number; // 1-based current step (5 = all done)
  skipped: boolean; // card step skipped
}) {
  return (
    <div className="flex items-center gap-0 mt-3">
      {STEPS.map((step, i) => {
        const stepNum = i + 1;
        const done = stepNum < active || active > 4;
        const current = stepNum === active && active <= 4;
        const isCardStep = stepNum === 3;
        const skippedStep = isCardStep && skipped && !done;

        return (
          <div key={i} className="flex items-center">
            {/* Circle */}
            <div className="flex flex-col items-center gap-1">
              <div
                className={cn(
                  "w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold border-2 transition-all",
                  done
                    ? "bg-green-500 border-green-500 text-white"
                    : skippedStep
                    ? "bg-slate-200 border-slate-300 text-slate-400"
                    : current
                    ? "bg-blue-600 border-blue-600 text-white shadow-sm shadow-blue-200"
                    : "bg-background border-border text-muted-foreground"
                )}
              >
                {done ? (
                  <CheckCircle2 size={14} strokeWidth={2.5} />
                ) : skippedStep ? (
                  <SkipForward size={11} />
                ) : (
                  stepNum
                )}
              </div>
              <span
                className={cn(
                  "text-[10px] font-medium whitespace-nowrap",
                  done
                    ? "text-green-600"
                    : current
                    ? "text-blue-600"
                    : skippedStep
                    ? "text-slate-400"
                    : "text-muted-foreground"
                )}
              >
                {step.short}
              </span>
            </div>
            {/* Connector line */}
            {i < STEPS.length - 1 && (
              <div
                className={cn(
                  "h-0.5 w-8 mb-4 transition-colors",
                  stepNum < active ? "bg-green-400" : "bg-border"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Per-step action panel ─────────────────────────────────────────────────────

function StepPanel({
  step,
  group,
  onRefresh,
}: {
  step: number;
  group: PersonGroup;
  onRefresh: () => void;
}) {
  const [pinLoading, setPinLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardCountdown, setCardCountdown] = useState(0);

  const displayName = group.entity_name ?? "the client";
  const device = group.primaryEntry.device_label;

  async function sendPin() {
    if (!group.phone) {
      toast.error("No phone number on record");
      return;
    }
    setPinLoading(true);
    try {
      const res = await fetch("/api/cosec/send-enrollment-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: group.entity_id }),
      });
      const json = await res.json();
      if (res.ok) toast.success(`Enrollment PIN sent to ${group.phone}`);
      else toast.error(json.error ?? "Failed to send PIN");
    } finally {
      setPinLoading(false);
    }
  }

  async function scanCard() {
    setCardLoading(true);
    // 20s countdown so admin knows how long to wait
    let remaining = 20;
    setCardCountdown(remaining);
    const timer = setInterval(() => {
      remaining -= 1;
      setCardCountdown(remaining);
      if (remaining <= 0) clearInterval(timer);
    }, 1000);

    try {
      const res = await fetch("/api/cosec/assign-card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: group.primaryEntry.id }),
      });
      clearInterval(timer);
      const json = await res.json();
      if (res.ok) {
        toast.success(`Card ${json.cardNumber} assigned to ${displayName}`);
        onRefresh();
      } else {
        toast.error(json.error ?? "No card detected. Tap card on the reader.");
      }
    } finally {
      clearInterval(timer);
      setCardLoading(false);
      setCardCountdown(0);
    }
  }

  if (step === 2) {
    return (
      <div className="mt-4 rounded-lg border border-blue-100 bg-blue-50/60 p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <Fingerprint size={18} className="text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-900">
              Step 2 — Fingerprint Enrollment
            </p>
            <p className="text-sm text-blue-700 mt-1 leading-relaxed">
              Ask <strong>{displayName}</strong> to walk up to the{" "}
              <strong>{device}</strong> reader and place their finger on the
              sensor. They&apos;ll be prompted to enter a PIN first.
            </p>

            {group.access_pin && (
              <div className="mt-2.5 inline-flex items-center gap-2 bg-white border border-blue-200 rounded px-3 py-1.5">
                <ShieldCheck size={13} className="text-blue-500" />
                <span className="text-xs text-muted-foreground">
                  Enrollment PIN:
                </span>
                <span className="font-mono font-bold text-sm text-blue-800 tracking-widest">
                  {group.access_pin}
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {group.phone && (
            <Button
              size="sm"
              variant="outline"
              disabled={pinLoading}
              onClick={sendPin}
              className="h-8 text-xs gap-1.5"
            >
              {pinLoading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Send size={12} />
              )}
              Resend PIN via SMS
            </Button>
          )}
          <span className="text-xs text-muted-foreground">
            The system will auto-detect when enrollment is complete.
          </span>
        </div>
      </div>
    );
  }

  if (step === 3) {
    return (
      <div className="mt-4 rounded-lg border border-violet-100 bg-violet-50/50 p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <CreditCard size={18} className="text-violet-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-violet-900">
              Step 3 — Issue NFC Access Card{" "}
              <span className="text-violet-400 font-normal">(optional)</span>
            </p>
            <p className="text-sm text-violet-700 mt-1 leading-relaxed">
              Give <strong>{displayName}</strong> an NFC card as a backup to
              their fingerprint. Have a blank card ready, then tap{" "}
              <strong>Scan Card Now</strong> and immediately tap the card on
              the <strong>{device}</strong> reader.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={cardLoading}
            onClick={scanCard}
            className="h-8 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700"
          >
            {cardLoading ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Waiting for card tap
                {cardCountdown > 0 && (
                  <span className="ml-1 opacity-75">{cardCountdown}s</span>
                )}
              </>
            ) : (
              <>
                <CreditCard size={12} />
                Scan Card Now
              </>
            )}
          </Button>
          {!cardLoading && (
            <span className="text-xs text-muted-foreground">
              or{" "}
              <button
                onClick={onRefresh}
                className="underline underline-offset-2 hover:text-foreground transition-colors"
              >
                skip this step
              </button>
            </span>
          )}
        </div>
      </div>
    );
  }

  if (step === 4) {
    return (
      <div className="mt-4 rounded-lg border border-amber-100 bg-amber-50/50 p-4">
        <div className="flex items-start gap-2.5">
          <DoorOpen size={18} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Step 4 — Verify First Access
            </p>
            <p className="text-sm text-amber-700 mt-1 leading-relaxed">
              Ask <strong>{displayName}</strong> to do a test scan at the{" "}
              <strong>{device}</strong> reader — fingerprint or card. Once
              they pass through, this step completes automatically.
            </p>
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="mt-3 h-8 text-xs gap-1.5"
          onClick={onRefresh}
        >
          <RefreshCw size={12} />
          Check if done
        </Button>
      </div>
    );
  }

  return null;
}

// ── Person card ───────────────────────────────────────────────────────────────

function PersonCard({
  group,
  onRefresh,
}: {
  group: PersonGroup;
  onRefresh: () => void;
}) {
  // "Skip card" is session-local state; card step will remain skipped
  // until they assign a real card (nfc_card_number set) or page reload
  const [cardSkipped, setCardSkipped] = useState(false);

  const step = currentStep(group, cardSkipped);
  const allDone = step === 5;

  const displayName = group.entity_name ?? `Ref #${group.primaryEntry.cosec_ref_id}`;
  const devices = group.allEntries.map((e) => e.device_label);
  const uniqueDevices = [...new Set(devices)];

  // When the "skip" link is clicked on step 3, mark skipped and advance
  function handleSkip() {
    setCardSkipped(true);
  }

  return (
    <div
      className={cn(
        "rounded-xl border p-4 transition-colors",
        allDone ? "border-green-200 bg-green-50/30" : "border-border bg-card"
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-sm">{displayName}</span>
            {group.phone && (
              <span className="text-xs text-muted-foreground">
                {group.phone}
              </span>
            )}
            {allDone && (
              <Badge
                variant="outline"
                className="text-[10px] border-green-400 text-green-700 bg-green-50 gap-1"
              >
                <CheckCircle2 size={10} />
                Complete
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap gap-x-2 gap-y-0.5 mt-0.5">
            {uniqueDevices.map((d) => (
              <span key={d} className="text-xs text-muted-foreground">
                {d}
              </span>
            ))}
          </div>
        </div>

        {/* Last seen chip */}
        {allDone && group.last_seen_at && (
          <div
            className={cn(
              "flex items-center gap-1.5 text-xs rounded-full px-2.5 py-1 shrink-0",
              group.is_inside
                ? "bg-green-100 text-green-700"
                : "bg-slate-100 text-slate-600"
            )}
          >
            <Wifi size={11} />
            {group.is_inside ? "Inside now" : `Last seen ${formatDate(group.last_seen_at)}`}
          </div>
        )}
      </div>

      {/* Step bar */}
      <StepBar active={step} skipped={cardSkipped && !group.nfc_card_number} />

      {/* Active step panel */}
      {!allDone && (
        <StepPanel
          step={step}
          group={group}
          onRefresh={() => {
            if (step === 3 && !cardSkipped) {
              handleSkip();
            } else {
              onRefresh();
            }
          }}
        />
      )}

      {/* All done summary */}
      {allDone && (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {group.biometric_enrolled_at && (
            <span className="flex items-center gap-1">
              <Fingerprint size={11} className="text-green-500" />
              Enrolled {formatDate(group.biometric_enrolled_at)}
            </span>
          )}
          {group.nfc_card_number && (
            <span className="flex items-center gap-1">
              <CreditCard size={11} className="text-green-500" />
              Card {group.nfc_card_number.slice(-8)}
            </span>
          )}
          {group.first_access_at && (
            <span className="flex items-center gap-1">
              <DoorOpen size={11} className="text-green-500" />
              First access {formatDate(group.first_access_at)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function CosecAccessWizard({ contractId }: { contractId: string }) {
  const [groups, setGroups] = useState<PersonGroup[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${contractId}/cosec-wizard`);
    if (!res.ok) { setLoading(false); return; }
    const json = await res.json();
    const entries: WizardEntry[] = json.data ?? [];

    if (entries.length === 0) {
      setGroups([]);
      setLoading(false);
      return;
    }

    // Group by entity_id
    const byEntity = new Map<string, WizardEntry[]>();
    for (const e of entries) {
      if (!byEntity.has(e.entity_id)) byEntity.set(e.entity_id, []);
      byEntity.get(e.entity_id)!.push(e);
    }

    const grouped: PersonGroup[] = [];
    for (const [, entryList] of byEntity) {
      const primary = entryList[0];
      const best = bestEnrollmentStatus(entryList);
      // Biometric enrolled at — pick the earliest non-null
      const bioAt = entryList
        .map((e) => e.biometric_enrolled_at)
        .filter(Boolean)
        .sort()[0] ?? null;
      // NFC card — any device having a card counts
      const card = entryList.find((e) => e.nfc_card_number)?.nfc_card_number ?? null;

      grouped.push({
        entity_id: primary.entity_id,
        user_type: primary.user_type,
        entity_name: primary.entity_name,
        phone: primary.phone,
        bestStatus: best,
        biometric_enrolled_at: bioAt ?? null,
        nfc_card_number: card,
        access_pin: primary.access_pin,
        first_access_at: primary.first_access_at,
        is_inside: primary.is_inside,
        last_seen_at: primary.last_seen_at,
        primaryEntry: primary,
        allEntries: entryList,
      });
    }

    setGroups(grouped);
    setLoading(false);
  }, [contractId]);

  useEffect(() => { load(); }, [load]);

  // Count how many are complete
  // (skip card is unknown here, so we use a static check)
  const completeCount = groups.filter(
    (g) =>
      !!g.biometric_enrolled_at && !!g.first_access_at
  ).length;

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldCheck size={16} />
            Access Onboarding
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-muted-foreground" size={20} />
          </div>
        </CardContent>
      </Card>
    );
  }

  if (groups.length === 0) {
    return null; // No COSEC users — don't show the section at all
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck size={16} />
              Access Onboarding
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              {completeCount === groups.length
                ? `All ${groups.length} ${groups.length === 1 ? "person" : "people"} fully set up`
                : `${completeCount} of ${groups.length} complete · follow the steps below for each person`}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={load}
            className="h-7 w-7 p-0 text-muted-foreground"
          >
            <RefreshCw size={13} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Legend — shown once at the top */}
        <div className="flex items-center gap-4 text-[11px] text-muted-foreground bg-muted/40 rounded-lg px-3 py-2">
          <span className="flex items-center gap-1">
            <CheckCircle2 size={11} className="text-green-500" /> Done
          </span>
          <span className="flex items-center gap-1">
            <div className="w-3.5 h-3.5 rounded-full bg-blue-600 flex items-center justify-center">
              <span className="text-[8px] text-white font-bold">→</span>
            </div>{" "}
            Action needed
          </span>
          <span className="flex items-center gap-1">
            <Circle size={11} className="text-border" /> Upcoming
          </span>
          <span className="flex items-center gap-1">
            <SkipForward size={11} className="text-slate-400" /> Optional / skipped
          </span>
        </div>

        {groups.map((group) => (
          <PersonCard key={group.entity_id} group={group} onRefresh={load} />
        ))}
      </CardContent>
    </Card>
  );
}

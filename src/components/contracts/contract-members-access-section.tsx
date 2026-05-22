"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  UserPlus,
  Fingerprint,
  CreditCard,
  Send,
  Loader2,
  ShieldCheck,
  ShieldOff,
  Wifi,
  WifiOff,
  Trash2,
  Clock,
  CheckCircle2,
  SkipForward,
  DoorOpen,
  RefreshCw,
  Circle,
} from "lucide-react";
import { formatDate } from "@/lib/utils";
import { cn } from "@/lib/utils";

// ── Member types ───────────────────────────────────────────────────────────────

interface DeviceAccess {
  device_id: string;
  enrollment_status: string;
  access_pin: string | null;
  nfc_card_number: string | null;
  provisioned_at: string | null;
  biometric_enrolled_at: string | null;
  blocked_at: string | null;
  device: { label: string } | null;
}

interface Member {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  is_active: boolean;
  created_at: string;
  access: DeviceAccess[];
}

interface Props {
  contractId: string;
  seats: number;
  contractStatus: string;
}

// ── Wizard types ───────────────────────────────────────────────────────────────

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
  device_category: "entry_point" | "business_centre";
  supports_biometric: boolean;
  entity_name: string | null;
  phone: string | null;
  first_access_at: string | null;
  last_seen_at: string | null;
  is_inside: boolean | null;
}

interface PersonGroup {
  entity_id: string;
  user_type: string;
  entity_name: string | null;
  phone: string | null;
  bestStatus: string;
  biometric_enrolled_at: string | null;
  nfc_card_number: string | null;
  access_pin: string | null;
  first_access_at: string | null;
  is_inside: boolean | null;
  last_seen_at: string | null;
  primaryEntry: WizardEntry;
  allEntries: WizardEntry[];
  // true if ANY entry-point device on this group supports biometric
  supports_biometric: boolean;
}

// ── Wizard helpers ─────────────────────────────────────────────────────────────

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
    return (STATUS_RANK[e.enrollment_status] ?? 0) > (STATUS_RANK[best] ?? 0)
      ? e.enrollment_status
      : best;
  }, "pending");
}

function currentStep(group: PersonGroup, cardSkipped: boolean): number {
  // For NFC-only devices, biometric is not required — treat it as always done.
  const biometricDone =
    !group.supports_biometric ||
    !!group.biometric_enrolled_at ||
    ["biometric_enrolled", "fully_enrolled", "card_enrolled"].includes(group.bestStatus);
  const cardDone = !!group.nfc_card_number;
  const accessDone = !!group.first_access_at;

  if (!biometricDone) return 2;
  if (!cardDone && !cardSkipped) return 3;
  if (!accessDone) return 4;
  return 5;
}

function buildWizardGroup(entityId: string, entryList: WizardEntry[]): PersonGroup {
  const primary =
    entryList.find((e) => e.device_category === "entry_point") ?? entryList[0];
  const best = bestEnrollmentStatus(entryList);
  const bioAt =
    entryList.map((e) => e.biometric_enrolled_at).filter(Boolean).sort()[0] ?? null;
  const card = entryList.find((e) => e.nfc_card_number)?.nfc_card_number ?? null;
  // Supports biometric if the primary entry-point device does.
  // Defaults true so existing data behaves as before until flag is set.
  const supportsBio = primary.supports_biometric ?? true;
  return {
    entity_id: entityId,
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
    supports_biometric: supportsBio,
  };
}

// ── Step bar ──────────────────────────────────────────────────────────────────

const STEPS_BIOMETRIC = [
  { short: "Created" },
  { short: "Biometric" },
  { short: "NFC Card" },
  { short: "Active" },
];

const STEPS_NFC_ONLY = [
  { short: "Created" },
  { short: "NFC Card" },
  { short: "Active" },
];

// For NFC-only, remap the 4-step numbering to 3 steps.
// step 1 = Created, step 3 = NFC Card (shown as 2), step 4 = Active (shown as 3), step 5 = done
function toDisplayStep(step: number, supportsBiometric: boolean): number {
  if (supportsBiometric) return step;
  // step 1→1, step 3→2, step 4→3, step 5→4 (all done)
  if (step <= 1) return 1;
  if (step === 3) return 2;
  if (step === 4) return 3;
  return 4; // done
}

function StepBar({ active, skipped, supportsBiometric }: { active: number; skipped: boolean; supportsBiometric: boolean }) {
  const steps = supportsBiometric ? STEPS_BIOMETRIC : STEPS_NFC_ONLY;
  const displayActive = toDisplayStep(active, supportsBiometric);
  return (
    <div className="flex items-center gap-0 mt-3">
      {steps.map((step, i) => {
        const stepNum = i + 1;
        const done = stepNum < displayActive || displayActive > steps.length;
        const current = stepNum === displayActive && displayActive <= steps.length;
        // Card step is the last step before Active
        const isCardStep = stepNum === steps.length - 1;
        const skippedStep = isCardStep && skipped && !done;

        return (
          <div key={i} className="flex items-center">
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
            {i < steps.length - 1 && (
              <div
                className={cn(
                  "h-0.5 w-8 mb-4 transition-colors",
                  stepNum < displayActive ? "bg-green-400" : "bg-border"
                )}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Step panel ────────────────────────────────────────────────────────────────

function StepPanel({
  step,
  group,
  onRefresh,
}: {
  step: number;
  group: PersonGroup;
  onRefresh: () => void;
  // Note: step is always in 4-step space; NFC-only just skips step 2
}) {
  const [pinLoading, setPinLoading] = useState(false);
  const [cardLoading, setCardLoading] = useState(false);
  const [cardCountdown, setCardCountdown] = useState(0);

  const displayName = group.entity_name ?? "the member";
  const device = group.primaryEntry.device_label;

  async function sendPin() {
    if (!group.phone) { toast.error("No phone number on record"); return; }
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
      <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50/60 p-3.5 space-y-2.5">
        <div className="flex items-start gap-2.5">
          <Fingerprint size={16} className="text-blue-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-blue-900">Step 2 — Fingerprint Enrollment</p>
            <p className="text-sm text-blue-700 mt-1 leading-relaxed">
              Ask <strong>{displayName}</strong> to walk up to the{" "}
              <strong>{device}</strong> device and{" "}
              <strong>type the PIN on the keypad</strong>. The device will then prompt
              them to scan their finger several times. The PIN is one-time only — after
              enrollment they just place their finger to enter.
            </p>
            {group.access_pin && (
              <div className="mt-2 inline-flex items-center gap-2 bg-white border border-blue-200 rounded px-3 py-1.5">
                <ShieldCheck size={13} className="text-blue-500" />
                <span className="text-xs text-muted-foreground">Enrollment PIN:</span>
                <span className="font-mono font-bold text-sm text-blue-800 tracking-widest">
                  {group.access_pin}
                </span>
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {group.phone && (
            <Button size="sm" variant="outline" disabled={pinLoading} onClick={sendPin} className="h-7 text-xs gap-1.5">
              {pinLoading ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
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
    const nfcOnly = !group.supports_biometric;
    return (
      <div className="mt-3 rounded-lg border border-violet-100 bg-violet-50/50 p-3.5 space-y-2.5">
        <div className="flex items-start gap-2.5">
          <CreditCard size={16} className="text-violet-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-violet-900">
              {nfcOnly ? "Step 2 — Issue NFC Access Card" : (
                <>Step 3 — Issue NFC Access Card{" "}<span className="text-violet-400 font-normal">(optional)</span></>
              )}
            </p>
            <p className="text-sm text-violet-700 mt-1 leading-relaxed">
              {nfcOnly
                ? <>Give <strong>{displayName}</strong> an NFC card — this is their <strong>primary access method</strong> for the <strong>{device}</strong> reader. Have a blank card ready, tap <strong>Scan Card Now</strong>, then immediately tap the card on the reader.</>
                : <>Give <strong>{displayName}</strong> an NFC card as a backup to their fingerprint. Have a blank card ready, tap <strong>Scan Card Now</strong>, then immediately tap the card on the <strong>{device}</strong> reader.</>
              }
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            disabled={cardLoading}
            onClick={scanCard}
            className="h-7 text-xs gap-1.5 bg-violet-600 hover:bg-violet-700"
          >
            {cardLoading ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Waiting for card tap
                {cardCountdown > 0 && <span className="ml-1 opacity-75">{cardCountdown}s</span>}
              </>
            ) : (
              <><CreditCard size={12} />Scan Card Now</>
            )}
          </Button>
          {!cardLoading && (
            <span className="text-xs text-muted-foreground">
              or{" "}
              <button onClick={onRefresh} className="underline underline-offset-2 hover:text-foreground transition-colors">
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
      <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50/50 p-3.5">
        <div className="flex items-start gap-2.5">
          <DoorOpen size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-semibold text-amber-900">Step 4 — Verify First Access</p>
            <p className="text-sm text-amber-700 mt-1 leading-relaxed">
              Ask <strong>{displayName}</strong> to do a test scan at the{" "}
              <strong>{device}</strong> reader — fingerprint or card. Once they pass
              through, this step completes automatically.
            </p>
          </div>
        </div>
        <Button size="sm" variant="outline" className="mt-2.5 h-7 text-xs gap-1.5" onClick={onRefresh}>
          <RefreshCw size={12} />
          Check if done
        </Button>
      </div>
    );
  }

  return null;
}

// ── Per-member lifecycle inline ────────────────────────────────────────────────

function MemberLifecycle({
  group,
  onRefresh,
}: {
  group: PersonGroup;
  onRefresh: () => void;
}) {
  const [cardSkipped, setCardSkipped] = useState(false);
  const step = currentStep(group, cardSkipped);
  const allDone = step === 5;

  return (
    <div className="mt-3 border-t pt-3">
      <StepBar active={step} skipped={cardSkipped && !group.nfc_card_number} supportsBiometric={group.supports_biometric} />

      {!allDone && (
        <StepPanel
          step={step}
          group={group}
          onRefresh={() => {
            if (step === 3 && !cardSkipped) {
              setCardSkipped(true);
            } else {
              onRefresh();
            }
          }}
        />
      )}

      {allDone && (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
          {group.last_seen_at && (
            <span className={cn(
              "flex items-center gap-1",
              group.is_inside ? "text-green-600" : ""
            )}>
              <Wifi size={11} />
              {group.is_inside ? "Inside now" : `Last seen ${formatDate(group.last_seen_at)}`}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── Member status badge ────────────────────────────────────────────────────────

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:            { label: "Pending",           variant: "secondary" },
  provisioned:        { label: "Awaiting Enroll",   variant: "outline" },
  biometric_enrolled: { label: "Biometric Active",  variant: "default" },
  card_enrolled:      { label: "Card Active",       variant: "default" },
  fully_enrolled:     { label: "Fully Enrolled",    variant: "default" },
  blocked:            { label: "Blocked",           variant: "destructive" },
  deleted:            { label: "Removed",           variant: "secondary" },
};

function overallStatus(access: DeviceAccess[]): string {
  if (access.length === 0) return "pending";
  const statuses = access.map(a => a.enrollment_status);
  if (statuses.some(s => s === "fully_enrolled")) return "fully_enrolled";
  if (statuses.some(s => s === "biometric_enrolled")) return "biometric_enrolled";
  if (statuses.some(s => s === "card_enrolled")) return "card_enrolled";
  if (statuses.some(s => s === "blocked")) return "blocked";
  if (statuses.some(s => s === "provisioned")) return "provisioned";
  return "pending";
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ContractMembersAccessSection({ contractId, seats, contractStatus }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [wizardGroupMap, setWizardGroupMap] = useState<Map<string, PersonGroup>>(new Map());
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const [membersRes, wizardRes] = await Promise.all([
      fetch(`/api/contracts/${contractId}/members`),
      fetch(`/api/contracts/${contractId}/cosec-wizard`),
    ]);

    if (membersRes.ok) {
      const json = await membersRes.json();
      setMembers((json.data ?? []).filter((m: Member) => m.is_active));
    }

    if (wizardRes.ok) {
      const json = await wizardRes.json();
      const entries: WizardEntry[] = json.data ?? [];
      const byEntity = new Map<string, WizardEntry[]>();
      for (const e of entries) {
        if (!byEntity.has(e.entity_id)) byEntity.set(e.entity_id, []);
        byEntity.get(e.entity_id)!.push(e);
      }
      const groupMap = new Map<string, PersonGroup>();
      for (const [entityId, entryList] of byEntity) {
        groupMap.set(entityId, buildWizardGroup(entityId, entryList));
      }
      setWizardGroupMap(groupMap);
    }

    setLoading(false);
  }, [contractId]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd() {
    if (!form.name || !form.phone) { toast.error("Name and phone are required"); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Failed to add member"); return; }
      toast.success(`${form.name} added${contractStatus === "active" ? " — enrollment PIN sent via SMS" : ""}`);
      setDialogOpen(false);
      setForm({ name: "", phone: "", email: "" });
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleSendPin(member: Member) {
    setActionLoading(a => ({ ...a, [`pin_${member.id}`]: true }));
    try {
      const res = await fetch("/api/cosec/send-enrollment-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: member.id }),
      });
      const json = await res.json();
      if (res.ok) toast.success(`Enrollment PIN resent to ${member.phone}`);
      else toast.error(json.error ?? "Failed to send PIN");
    } finally {
      setActionLoading(a => ({ ...a, [`pin_${member.id}`]: false }));
    }
  }

  async function handleBlock(member: Member) {
    setActionLoading(a => ({ ...a, [`block_${member.id}`]: true }));
    try {
      const firstAccess = member.access[0];
      if (!firstAccess) { toast.error("No device access to block"); return; }
      const res = await fetch("/api/cosec/block-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: firstAccess.device_id }),
      });
      if (res.ok) { toast.success("Access blocked"); await load(); }
      else toast.error("Failed to block");
    } finally {
      setActionLoading(a => ({ ...a, [`block_${member.id}`]: false }));
    }
  }

  async function handleRemove(member: Member) {
    if (!confirm(`Remove ${member.name}? This will also block their device access.`)) return;
    setActionLoading(a => ({ ...a, [`remove_${member.id}`]: true }));
    try {
      const res = await fetch(`/api/contracts/${contractId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: member.id }),
      });
      if (res.ok) { toast.success(`${member.name} removed`); await load(); }
      else toast.error("Failed to remove");
    } finally {
      setActionLoading(a => ({ ...a, [`remove_${member.id}`]: false }));
    }
  }

  const activeCount = members.length;
  const canAdd = contractStatus === "active" || contractStatus === "draft";

  // Step legend — shown once at top when there are members with access
  const hasWizardData = wizardGroupMap.size > 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Fingerprint size={16} />
              Members &amp; Access Control
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              {activeCount} of {seats} seats filled · Each member gets WiFi voucher + biometric/card access
            </p>
          </div>
          {canAdd && activeCount < seats && (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <UserPlus size={14} className="mr-1.5" />
              Add Member
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {/* Step legend — shown once when there's at least one enrollment */}
        {hasWizardData && (
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
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-muted-foreground" size={22} />
          </div>
        ) : members.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Fingerprint size={36} className="mx-auto mb-2 opacity-25" />
            <p className="font-medium text-sm">No members added yet</p>
            <p className="text-xs mt-1">
              Add members to issue WiFi vouchers and set up biometric / NFC card access.
            </p>
          </div>
        ) : (
          members.map((member) => {
            const status = overallStatus(member.access);
            const badge  = STATUS_BADGE[status] ?? STATUS_BADGE.pending;
            const isPinLoading    = actionLoading[`pin_${member.id}`];
            const isBlockLoading  = actionLoading[`block_${member.id}`];
            const isRemoveLoading = actionLoading[`remove_${member.id}`];
            const isBlocked       = status === "blocked";
            const wizardGroup     = wizardGroupMap.get(member.id);

            return (
              <div
                key={member.id}
                className={cn(
                  "rounded-lg border px-4 py-3",
                  isBlocked ? "opacity-60" : "",
                  wizardGroup && currentStep(wizardGroup, false) === 5
                    ? "border-green-200 bg-green-50/30"
                    : ""
                )}
              >
                {/* Identity + actions row */}
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{member.name}</span>
                      <Badge variant={badge.variant} className="text-xs">{badge.label}</Badge>
                      {wizardGroup && currentStep(wizardGroup, false) === 5 && (
                        <Badge variant="outline" className="text-[10px] border-green-400 text-green-700 bg-green-50 gap-1">
                          <CheckCircle2 size={10} />
                          Complete
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
                      <span>{member.phone}</span>
                      {member.email && <span>{member.email}</span>}
                    </div>

                    {/* Per-device chips */}
                    {member.access.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {member.access.map((au) => {
                          const s = STATUS_BADGE[au.enrollment_status] ?? STATUS_BADGE.pending;
                          const isActive =
                            au.enrollment_status === "biometric_enrolled" ||
                            au.enrollment_status === "fully_enrolled" ||
                            au.enrollment_status === "card_enrolled";
                          return (
                            <div key={au.device_id} className="flex items-center gap-1 text-xs bg-muted/50 rounded px-2 py-0.5">
                              {isActive
                                ? <Wifi size={11} className="text-green-500" />
                                : au.enrollment_status === "blocked"
                                  ? <WifiOff size={11} className="text-red-400" />
                                  : <Clock size={11} className="text-muted-foreground" />
                              }
                              <span className="text-muted-foreground">
                                {(au.device as { label: string } | null)?.label ?? "Device"}
                              </span>
                              <span className={isActive ? "text-green-600 font-medium" : "text-muted-foreground"}>
                                {s.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {/* Only show Resend PIN for biometric devices — NFC-only has no enrollment PIN */}
                    {status === "provisioned" && wizardGroup?.supports_biometric !== false && (
                      <Button
                        size="sm" variant="outline" className="text-xs h-7"
                        onClick={() => handleSendPin(member)}
                        disabled={isPinLoading}
                        title="Resend enrollment PIN"
                      >
                        {isPinLoading
                          ? <Loader2 size={13} className="animate-spin" />
                          : <><Send size={12} className="mr-1" />Resend PIN</>
                        }
                      </Button>
                    )}
                    {!isBlocked && status !== "provisioned" && status !== "pending" && (
                      <Button
                        size="sm" variant="ghost" className="text-xs h-7 text-red-600 hover:text-red-700"
                        onClick={() => handleBlock(member)}
                        disabled={isBlockLoading}
                        title="Block device access"
                      >
                        {isBlockLoading ? <Loader2 size={13} className="animate-spin" /> : <ShieldOff size={13} />}
                      </Button>
                    )}
                    <Button
                      size="sm" variant="ghost" className="text-xs h-7 text-muted-foreground"
                      onClick={() => handleRemove(member)}
                      disabled={isRemoveLoading}
                      title="Remove member"
                    >
                      {isRemoveLoading ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </Button>
                  </div>
                </div>

                {/* Inline lifecycle per member */}
                {wizardGroup && (
                  <MemberLifecycle group={wizardGroup} onRefresh={load} />
                )}
              </div>
            );
          })
        )}
      </CardContent>

      {/* Add member dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label>Full Name <span className="text-red-500">*</span></Label>
              <Input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Ravi Kumar"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone <span className="text-red-500">*</span></Label>
              <Input
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="9876543210"
                type="tel"
              />
              <p className="text-xs text-muted-foreground">Enrollment PIN will be sent to this number via SMS</p>
            </div>
            <div className="space-y-1.5">
              <Label>Email <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="ravi@company.com"
                type="email"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin mr-2" />}
              Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

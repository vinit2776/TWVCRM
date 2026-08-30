"use client";

/**
 * Facility Issue — detail / work page.
 *
 * Layout:
 *   Mobile: stacked. Header → big action buttons → details → timeline.
 *   Desktop: 2-column. Left = details + timeline; right = sidebar with assignment + SLA + actions.
 *
 * Ownership model (Claim Model):
 *   - Unowned (new/reopened, no assigned_to): any user sees "Claim" button + countdown
 *   - Owned by self: Start Work / Resolve / Close buttons active
 *   - Owned by someone else: "Assigned to [Name]" notice + "Take over" button
 *   - Override tier (admin / manager / office_admin): always sees action buttons + Reassign
 */

import { useEffect, useMemo, useState, use, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft, AlertTriangle, Loader2, MessageSquare, MapPin, User,
  Server, Clock, RefreshCw, CheckCircle2, Wrench, Star, ImagePlus,
  Phone, Mail, ExternalLink, ShieldAlert, Bell, Check, CheckCheck, X,
  TimerReset, Trophy, MoreHorizontal,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import {
  PRIORITY_STYLES, STATUS_STYLES, ROOT_CAUSE_LIST, ROOT_CAUSE_LABEL,
  REPORTED_VIA_LABEL, formatDuration, timeAgo, timeUntil, nextStatusOptions,
  TAT_REASON_LABEL, TAT_REASON_LIST_EXEMPT, TAT_REASON_LIST_CONTROLLABLE, kpiPointsStyle,
  STATUS_ACTION_PRIORITY, getTatStatus, SCOPE_LABEL,
} from "@/lib/facility-ui";
import { FacilityPhotoUpload, type FacilityUploadedPhoto } from "@/components/facility/photo-upload";
import { LifecycleStepper } from "@/components/facility/lifecycle-stepper";
import { MentionTextarea, type MentionUser } from "@/components/facility/mention-textarea";
import type {
  FacilityIssue, FacilityIssueStatus, FacilityRootCause, FacilityTatReason, FacilityIssueTatExtension,
} from "@/types";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import { pushTrailEntry } from "@/lib/nav-trail";

interface AssigneeOption { id: string; full_name: string; role: string }
interface Collaborator { id: string; user_id: string; user: { id: string; full_name: string; email: string; role: string } }
interface CurrentUser { id: string; full_name: string; role: string }
interface NudgeRecord {
  id: string;
  channel: "push" | "whatsapp" | "email";
  status: "sent" | "delivered" | "read" | "opened" | "failed";
  sent_at: string;
  error_message: string | null;
  sender?: { full_name: string } | null;
}

interface AssetAmcSummary {
  amc_status: string | null;
  amc_end_date: string | null;
  amc_contact_name: string | null;
  amc_helpline_number: string | null;
  amc_contact_email: string | null;
  amc_escalation_name: string | null;
  amc_escalation_phone: string | null;
  amc_scope_covered: string | null;
  vendor_name: string | null;
}

interface AssetDetail {
  id: string;
  notes: string | null;
  attention_notes: string | null;
  warranty_expiry: string | null;
  make: string | null;
  model: string | null;
  amc: AssetAmcSummary | null;
  recent_issues: { id: string; issue_number: string; title: string; created_at: string }[];
}

const OVERRIDE_ROLES = ["admin", "manager", "office_admin"];

const STATUS_ACTION_LABEL: Record<string, string> = {
  in_progress: "Start Work",
  resolved: "Resolve",
  reopened: "Reopen",
};
const STATUS_ACTION_ICON: Record<string, typeof Wrench> = {
  in_progress: Wrench,
  resolved: CheckCircle2,
  reopened: RefreshCw,
};

/** Highlights the "@Full Name" substrings for users actually recorded as mentioned on this event. */
function renderMessageWithMentions(text: string, mentionedUserIds: string[] | undefined, roster: MentionUser[]) {
  const names = (mentionedUserIds ?? [])
    .map((id) => roster.find((u) => u.id === id)?.full_name)
    .filter((n): n is string => !!n)
    .sort((a, b) => b.length - a.length); // longest first so "@Jay" can't swallow a match meant for "@Jayesh"
  if (names.length === 0) return text;

  const pattern = names.map((n) => `@${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).join("|");
  const parts = text.split(new RegExp(`(${pattern})`, "g"));
  return parts.map((part, i) =>
    names.some((n) => part === `@${n}`)
      ? <span key={i} className="font-semibold text-primary bg-secondary rounded px-1">{part}</span>
      : part
  );
}

function useClaimCountdown(claimSlaTargetAt: string | null | undefined) {
  const [remaining, setRemaining] = useState<number | null>(null);
  useEffect(() => {
    if (!claimSlaTargetAt) return;
    const tick = () => setRemaining(new Date(claimSlaTargetAt).getTime() - Date.now());
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, [claimSlaTargetAt]);
  return remaining;
}

function formatCountdown(ms: number): string {
  if (ms <= 0) {
    const abs = Math.abs(ms);
    const h = Math.floor(abs / 3_600_000);
    const m = Math.floor((abs % 3_600_000) / 60_000);
    return h > 0 ? `Overdue ${h}h ${m}m ago` : `Overdue ${m}m ago`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `Claim within ${h}h ${m}m` : `Claim within ${m}m`;
}

export default function FacilityIssueDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [issue, setIssue] = useState<FacilityIssue | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState("");
  const [commentMentionIds, setCommentMentionIds] = useState<string[]>([]);
  const [mentionRoster, setMentionRoster] = useState<MentionUser[]>([]);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [collabOpen, setCollabOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [assetDetail, setAssetDetail] = useState<AssetDetail | null>(null);
  const [nudges, setNudges] = useState<NudgeRecord[]>([]);
  const [nudging, setNudging] = useState(false);
  const [extensions, setExtensions] = useState<FacilityIssueTatExtension[]>([]);
  const [extendOpen, setExtendOpen] = useState(false);
  const [extendHours, setExtendHours] = useState("24");
  const [extendReason, setExtendReason] = useState<FacilityTatReason | "">("");
  const [extendExplanation, setExtendExplanation] = useState("");
  const [extending, setExtending] = useState(false);
  // Defaults to true (hidden) until the effect below checks localStorage, so
  // the hint never flashes on for a user who already dismissed it.
  const [extendHintDismissed, setExtendHintDismissed] = useState(true);
  const assetFetchedRef = useRef<string | null>(null);

  useEffect(() => {
    setExtendHintDismissed(localStorage.getItem("facility_extend_hint_dismissed") === "1");
  }, []);
  const dismissExtendHint = () => {
    localStorage.setItem("facility_extend_hint_dismissed", "1");
    setExtendHintDismissed(true);
  };

  const fetchIssue = async () => {
    setLoading(true);
    const res = await fetch(`/api/facility/issues/${id}`);
    const json = await res.json();
    if (res.ok) setIssue(json.data);
    else toast.error(json.error || "Failed to load issue");
    setLoading(false);
  };

  const fetchCollaborators = async () => {
    const res = await fetch(`/api/facility/issues/${id}/collaborators`);
    const json = await res.json();
    if (res.ok) setCollaborators(json.data ?? []);
  };

  const fetchNudges = async () => {
    const res = await fetch(`/api/facility/issues/${id}/nudge`);
    const json = await res.json();
    if (res.ok) setNudges(json.data ?? []);
  };

  const fetchExtensions = async () => {
    const res = await fetch(`/api/facility/issues/${id}/extend`);
    const json = await res.json();
    if (res.ok) setExtensions(json.data ?? []);
  };

  useEffect(() => {
    fetchIssue();
    fetchCollaborators();
    fetchNudges();
    fetchExtensions();
    fetch("/api/me")
      .then((r) => r.json())
      .then((j) => setCurrentUser(j ?? null))
      .catch(() => null);
    // Full user directory for @mention — deliberately not /api/facility/assignees,
    // which is scoped to FMS/admin/manager. Anyone can be tagged into a comment.
    fetch("/api/users")
      .then((r) => r.json())
      .then((j) => setMentionRoster(
        ((j.data ?? []) as { id: string; full_name: string; role: string; is_active: boolean }[])
          .filter((u) => u.is_active)
          .map((u) => ({ id: u.id, full_name: u.full_name, role: u.role }))
      ))
      .catch(() => setMentionRoster([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Fetch asset AMC detail when asset_id is known (once per asset)
  useEffect(() => {
    if (!issue?.asset_id) return;
    if (assetFetchedRef.current === issue.asset_id) return;
    assetFetchedRef.current = issue.asset_id;

    Promise.all([
      fetch(`/api/facility/assets/${issue.asset_id}`).then((r) => r.json()),
      fetch(`/api/facility/assets/${issue.asset_id}/amc`).then((r) => r.json()),
      fetch(`/api/facility/issues?asset_id=${issue.asset_id}&limit=5`).then((r) => r.json()),
    ]).then(([assetRes, amcRes, issuesRes]) => {
      const asset = assetRes.data;
      if (!asset) return;
      const contracts = amcRes.contracts ?? [];
      const activeAmc = contracts.find(
        (c: { amc_status: string }) => c.amc_status === "active" || c.amc_status === "expiring"
      ) ?? contracts[0] ?? null;
      const recentIssues = ((issuesRes.data ?? []) as FacilityIssue[])
        .filter((i) => i.id !== id)
        .slice(0, 3)
        .map((i) => ({ id: i.id, issue_number: i.issue_number, title: i.title, created_at: i.created_at }));

      setAssetDetail({
        id: asset.id,
        notes: asset.notes ?? null,
        attention_notes: asset.attention_notes ?? null,
        warranty_expiry: asset.warranty_expiry ?? null,
        make: asset.make ?? null,
        model: asset.model ?? null,
        amc: activeAmc ? {
          amc_status: activeAmc.amc_status ?? null,
          amc_end_date: activeAmc.amc_end_date ?? null,
          amc_contact_name: activeAmc.amc_contact_name ?? null,
          amc_helpline_number: activeAmc.amc_helpline_number ?? null,
          amc_contact_email: activeAmc.amc_contact_email ?? null,
          amc_escalation_name: activeAmc.amc_escalation_name ?? null,
          amc_escalation_phone: activeAmc.amc_escalation_phone ?? null,
          amc_scope_covered: activeAmc.amc_scope_covered ?? null,
          vendor_name: activeAmc.procurement_vendors?.name ?? null,
        } : null,
        recent_issues: recentIssues,
      });
    }).catch(() => null);
  }, [issue?.asset_id, id]);

  // Load assignable users for the assign/collab dialog
  useEffect(() => {
    if (!assignOpen && !collabOpen) return;
    fetch("/api/facility/assignees")
      .then((r) => r.json())
      .then((j) => setAssignees((j.data || []).filter((u: AssigneeOption) => u.id)))
      .catch(() => setAssignees([]));
  }, [assignOpen, collabOpen]);

  const open = !!issue && ["new", "acknowledged", "in_progress", "reopened"].includes(issue.status);

  // Live-ticks the TAT banner's status (on_track/at_risk/overdue) so it
  // doesn't go stale while a technician just sits on the page. Local
  // interval, not a shared hook — this ticks indefinitely past deadline and
  // derives a category, a different enough shape from the claim countdown
  // (which counts to zero and fires a terminal action) to not share one.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, [open]);
  const tatStatus = open ? getTatStatus(issue?.sla_target_at, now) : null;

  const allowedNext = useMemo(() => issue ? nextStatusOptions(issue.status) : [], [issue]);
  const primaryStatusAction = useMemo(
    () => STATUS_ACTION_PRIORITY.find((s) => allowedNext.includes(s)) ?? null,
    [allowedNext]
  );
  const overflowStatusActions = useMemo(
    () => allowedNext.filter((s) => s !== primaryStatusAction),
    [allowedNext, primaryStatusAction]
  );

  const isOverrideTier = OVERRIDE_ROLES.includes(currentUser?.role ?? "");
  const isOwner = !!currentUser && issue?.assigned_to === currentUser.id;
  const isUnowned = !!issue && !issue.assigned_to && (issue.status === "new" || issue.status === "reopened");
  const canAct = isOwner || isOverrideTier;
  // Nudging prompts the assignee for an update — never show it to the assignee
  // themselves or to collaborators already on the ticket's team, even if they'd
  // otherwise qualify via override tier or being the reporter.
  const isCollaborator = collaborators.some((c) => c.user_id === currentUser?.id);
  const canNudge = !!issue?.assigned_to && !!currentUser && !isOwner && !isCollaborator &&
    (isOverrideTier || issue.reported_by === currentUser.id);
  const canExtend = isOwner && open && (issue?.tat_extension_count ?? 0) < 2;
  // Narrower than isOverrideTier — flipping an extension's KPI-exempt flag
  // is admin/manager only, unlike the rest of the override tier.
  const canPassCard = ["admin", "manager"].includes(currentUser?.role ?? "");

  const claimCountdownMs = useClaimCountdown(isUnowned ? issue?.claim_sla_target_at : null);

  // Self-claim ownership action available to ANY user (claim if unowned, take
  // over if owned by someone else). For override tier, moving ownership to
  // the right person — Assign/Reassign — is the prime action instead; the
  // self-claim option doesn't disappear, it just drops to a secondary slot.
  const ownershipAction: { type: "claim" | "take_over"; label: string } | null = isUnowned
    ? { type: "claim", label: "Claim this ticket" }
    : (!isOwner && issue?.assigned_to && open)
    ? { type: "take_over", label: "Take over" }
    : null;
  const showAssignAsPrimary = isOverrideTier && !!ownershipAction;
  const assignLabel = issue?.assignee?.full_name ? "Reassign" : "Assign to…";

  // ---- transitions ---------------------------------------------------------
  const changeStatus = async (next: FacilityIssueStatus, extra?: Record<string, unknown>) => {
    if (!issue) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next, ...(extra ?? {}) }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Status change failed");
      toast.success(`Status: ${next}`);
      await fetchIssue();
      setResolveOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Status change failed");
    } finally {
      setBusy(false);
    }
  };

  const claimTicket = async () => {
    if (!issue || !currentUser) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_id: currentUser.id }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Claim failed");
      toast.success("Ticket claimed — you are now the owner");
      await fetchIssue();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Claim failed");
    } finally {
      setBusy(false);
    }
  };

  const takeOver = async () => {
    if (!issue) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ take_over: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Take-over failed");
      toast.success("You are now the owner of this ticket");
      await fetchIssue();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Take-over failed");
    } finally {
      setBusy(false);
    }
  };

  const sendNudge = async () => {
    if (!issue) return;
    setNudging(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/nudge`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Nudge failed");
      const sentChannels = (json.data ?? []).filter((r: { status: string }) => r.status === "sent").length;
      toast.success(sentChannels > 0 ? `Nudge sent on ${sentChannels} channel${sentChannels > 1 ? "s" : ""}` : "Nudge attempted — no channels available");
      await fetchNudges();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Nudge failed");
    } finally {
      setNudging(false);
    }
  };

  const submitExtend = async () => {
    if (!issue || !extendReason || !extendExplanation.trim() || !extendHours) return;
    setExtending(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/extend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hours: Number(extendHours), reason_category: extendReason, explanation: extendExplanation.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Extension failed");
      toast.success("TAT extended");
      setExtendOpen(false);
      setExtendReason("");
      setExtendExplanation("");
      setExtendHours("24");
      await Promise.all([fetchIssue(), fetchExtensions()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Extension failed");
    } finally {
      setExtending(false);
    }
  };

  const passCard = async (extensionId: string, kpiExempt: boolean) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${id}/extend/${extensionId}/pass-card`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kpi_exempt: kpiExempt }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Pass card failed");
      toast.success(`Extension marked ${kpiExempt ? "KPI-exempt" : "counts against KPI"}`);
      await Promise.all([fetchIssue(), fetchExtensions()]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pass card failed");
    } finally {
      setBusy(false);
    }
  };

  const submitComment = async () => {
    if (!issue || !comment.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: comment.trim(), mentionedUserIds: commentMentionIds }),
      });
      if (!res.ok) throw new Error("Failed to add comment");
      setComment("");
      setCommentMentionIds([]);
      await fetchIssue();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const submitAttachment = async (p: FacilityUploadedPhoto) => {
    if (!issue) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...p, phase: open ? "progress" : "report" }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || "Failed to attach photo");
      }
      await fetchIssue();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to attach photo");
    } finally {
      setBusy(false);
    }
  };

  const assignTo = async (assigneeId: string | null) => {
    if (!issue) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/assign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignee_id: assigneeId }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Assign failed");
      setAssignOpen(false);
      await fetchIssue();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const addCollaborator = async (userId: string) => {
    if (!issue) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/collaborators`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) throw new Error("Failed to add collaborator");
      await fetchCollaborators();
      setCollabOpen(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const removeCollaborator = async (userId: string) => {
    if (!issue) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/collaborators`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      });
      if (!res.ok) throw new Error("Failed to remove");
      await fetchCollaborators();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading || !issue) {
    return (
      <div className="p-6 max-w-5xl mx-auto">
        <div className="text-sm text-muted-foreground">Loading…</div>
      </div>
    );
  }

  // Drives the full-width TAT banner below the header (not a small pill —
  // deadline urgency deserves the same visual weight as ownership urgency).
  const tatBannerStyle = tatStatus === "overdue"
    ? { wrap: "bg-red-50 border-red-200", icon: "text-red-600", text: "text-red-700" }
    : tatStatus === "at_risk"
    ? { wrap: "bg-amber-50 border-amber-200", icon: "text-amber-600", text: "text-amber-700" }
    : { wrap: "bg-emerald-50 border-emerald-200", icon: "text-emerald-600", text: "text-emerald-700" };

  // Delegated tasks always have a creator-supplied due date (mandatory at
  // creation, no auto-compute path) — tat_manual_override only applies to
  // reported_problem tickets, which default to a priority-based auto value
  // unless the reporter explicitly overrode it at creation time.
  const creatorName = issue.reporter?.full_name ?? issue.reporter_name ?? "creator";
  const tatSourceLabel = issue.task_type === "delegated_task" || issue.tat_manual_override
    ? `Set by ${creatorName}`
    : "Auto-set from priority default";

  const statusLabel = isUnowned ? "Unclaimed" : STATUS_STYLES[issue.status].label;
  const statusChipClass = isUnowned ? "bg-amber-50 text-amber-700 ring-amber-200" : STATUS_STYLES[issue.status].chip;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <PageBreadcrumb
        current={{ label: issue.title }}
        fallbackParent={{ href: "/facility/issues", label: "Issues" }}
      />
      {/* ───── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-muted-foreground">{issue.issue_number}</code>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full ring-1 bg-slate-50 text-slate-600 ring-slate-200">
              {SCOPE_LABEL[issue.scope]}
            </span>
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", statusChipClass)}>
              {statusLabel}
            </span>
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1 inline-flex items-center gap-1", PRIORITY_STYLES[issue.priority].chip)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", PRIORITY_STYLES[issue.priority].dot)} />
              {PRIORITY_STYLES[issue.priority].label}
            </span>
            {issue.kpi_points != null && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1 font-medium inline-flex items-center gap-1", kpiPointsStyle(issue.kpi_points).className)}>
                <Trophy className="h-2.5 w-2.5" /> {kpiPointsStyle(issue.kpi_points).label}
              </span>
            )}
          </div>
          <h1 className="text-base md:text-lg font-semibold mt-1 break-words">{issue.title}</h1>
          <LifecycleStepper status={issue.status} />
        </div>
        <Button variant="ghost" size="icon" onClick={fetchIssue} disabled={loading} title="Refresh">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

      {/* ───── TAT status banner — bold, full-width, same treatment as the claim
          countdown banner below. Replaces the small header pill; deadline
          urgency deserves the same visual weight as ownership urgency. Second
          line answers "what exact date/time, and who set it" — the relative
          countdown alone doesn't say whether a human chose this deadline or
          the system defaulted it from priority. ──────────────────────────── */}
      {open && issue.sla_target_at && (
        <div className={cn("rounded-lg border px-4 py-3 flex items-start gap-3", tatBannerStyle.wrap)}>
          <Clock className={cn("h-4 w-4 shrink-0 mt-0.5", tatBannerStyle.icon)} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className={cn("text-sm font-semibold", tatBannerStyle.text)}>
                {tatStatus === "overdue" ? "Overdue" : "Due"} {timeUntil(issue.sla_target_at)}
              </span>
              <span className="text-xs text-muted-foreground">(TAT)</span>
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {formatDateTime(issue.sla_target_at)} · {tatSourceLabel}
            </div>
          </div>
        </div>
      )}

      {/* ───── Reporter — kept near the top so contact info is reachable without
          scrolling past 8 other cards; this is who to call/message first. ── */}
      <section className="rounded-lg border bg-card p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] text-muted-foreground uppercase tracking-wide">Reported by</div>
          <div className="text-sm font-medium truncate">{issue.reporter?.full_name ?? issue.reporter_name ?? "—"}</div>
          <div className="text-xs text-muted-foreground">{timeAgo(issue.reported_at)} · via {REPORTED_VIA_LABEL[issue.reported_via]}</div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {issue.reporter_phone && (
            <a href={`tel:${issue.reporter_phone}`} className="h-11 w-11 rounded-full border flex items-center justify-center text-primary hover:bg-muted/40" title="Call reporter">
              <Phone className="h-4 w-4" />
            </a>
          )}
          {issue.reporter_email && (
            <a href={`mailto:${issue.reporter_email}`} className="h-11 w-11 rounded-full border flex items-center justify-center text-primary hover:bg-muted/40" title="Email reporter">
              <Mail className="h-4 w-4" />
            </a>
          )}
        </div>
      </section>

      {/* ───── Claim countdown banner (unowned tickets only) ─────────────── */}
      {isUnowned && claimCountdownMs !== null && (
        <div className={cn(
          "rounded-lg border px-4 py-3 flex items-center gap-3",
          claimCountdownMs <= 0 ? "bg-red-50 border-red-200" : "bg-amber-50 border-amber-200",
        )}>
          <Clock className={cn("h-4 w-4 shrink-0", claimCountdownMs <= 0 ? "text-red-600" : "text-amber-600")} />
          <span className={cn("text-sm font-medium", claimCountdownMs <= 0 ? "text-red-700" : "text-amber-700")}>
            {formatCountdown(claimCountdownMs)}
          </span>
          <span className="text-xs text-muted-foreground">— no one owns this ticket yet</span>
        </div>
      )}

      {/* ───── Action row — one obvious primary, up to 2 secondary, rest in
          "More actions" so a phone never shows 6+ same-weight buttons.
          For override tier, moving ownership to the right person (Assign/
          Reassign) is the prime action on an unowned or other-owned ticket —
          not self-claiming, which drops to a secondary slot instead. ────── */}
      <div className="flex items-stretch gap-2 flex-wrap">
        {/* Primary — the single obvious next step */}
        {showAssignAsPrimary ? (
          <Button onClick={() => setAssignOpen(true)} disabled={busy} className="flex-1 sm:flex-none">
            <User className="h-4 w-4 mr-1" /> {assignLabel}
          </Button>
        ) : ownershipAction ? (
          <Button
            onClick={ownershipAction.type === "claim" ? claimTicket : takeOver}
            disabled={busy}
            className={cn(
              "flex-1 sm:flex-none",
              ownershipAction.type === "claim" && "bg-amber-600 hover:bg-amber-700 text-white",
            )}
          >
            <User className="h-4 w-4 mr-1" /> {ownershipAction.label}
          </Button>
        ) : canAct && primaryStatusAction ? (
          <Button
            onClick={() => primaryStatusAction === "resolved" ? setResolveOpen(true) : changeStatus(primaryStatusAction)}
            disabled={busy}
            className="flex-1 sm:flex-none"
          >
            {(() => { const Icon = STATUS_ACTION_ICON[primaryStatusAction]; return <Icon className="h-4 w-4 mr-1" />; })()}
            {STATUS_ACTION_LABEL[primaryStatusAction]}
          </Button>
        ) : null}

        {/* Secondary — up to 2-3 frequent actions stay visible. Self-claim
            reappears here (not gone, just demoted) when Assign/Reassign took
            the primary slot. */}
        {showAssignAsPrimary && ownershipAction && (
          <Button
            size="sm"
            variant="outline"
            onClick={ownershipAction.type === "claim" ? claimTicket : takeOver}
            disabled={busy}
          >
            <User className="h-4 w-4 mr-1" /> {ownershipAction.label}
          </Button>
        )}
        {canNudge && (
          <Button size="sm" variant="outline" onClick={sendNudge} disabled={nudging}>
            {nudging ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Bell className="h-4 w-4 mr-1" />}
            Ask for update
          </Button>
        )}
        {canExtend && (
          <Button size="sm" variant="outline" onClick={() => setExtendOpen(true)} disabled={busy}>
            <TimerReset className="h-4 w-4 mr-1" /> Push back deadline ({2 - (issue.tat_extension_count ?? 0)} left)
          </Button>
        )}

        {/* Overflow — everything else. Assign/Reassign still lives here for
            override tier when it's NOT already shown as primary above (e.g.
            they already own the ticket, or it's resolved/closed). */}
        {(isOverrideTier || (canAct && overflowStatusActions.length > 0)) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={busy} title="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canAct && overflowStatusActions.map((s) => (
                <DropdownMenuItem
                  key={s}
                  onClick={() => s === "resolved" ? setResolveOpen(true) : changeStatus(s)}
                >
                  {STATUS_ACTION_LABEL[s]}
                </DropdownMenuItem>
              ))}
              {isOverrideTier && !showAssignAsPrimary && (
                <DropdownMenuItem onClick={() => setAssignOpen(true)}>
                  {assignLabel}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* One-time hint explaining "Push back deadline" — dismissed once,
          never shown again for this user. Doesn't gate visibility by time
          (explicit product decision — always-available once owned), just
          teaches what the button does the first time someone sees it. */}
      {canExtend && !extendHintDismissed && (
        <div className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span className="flex-1">
            Running behind? &ldquo;Push back deadline&rdquo; gives this ticket more time — up to 2 uses per ticket.
          </span>
          <button
            type="button"
            onClick={dismissExtendHint}
            className="text-amber-700 hover:text-amber-900 shrink-0"
            aria-label="Dismiss hint"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Owned-by-other notice (not owner, not override tier) */}
      {!isUnowned && !isOwner && !isOverrideTier && issue.assigned_to && (
        <div className="rounded-lg border bg-muted/30 px-4 py-3 text-sm text-muted-foreground flex items-center gap-2">
          <ShieldAlert className="h-4 w-4 shrink-0" />
          Assigned to <strong className="text-foreground ml-1">{issue.assignee?.full_name}</strong>
          <span className="ml-1">— only they can move this forward.</span>
        </div>
      )}

      {/* ───── Two-column layout (stacks on mobile) ───────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Main */}
        <div className="md:col-span-2 space-y-4">
          {/* Description */}
          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Description</div>
            <p className="text-sm whitespace-pre-wrap">
              {issue.description || <span className="text-muted-foreground italic">No description provided</span>}
            </p>
          </section>

          {/* Photos */}
          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Photos</div>
              <FacilityPhotoUpload
                pathPrefix={`issue/${issue.id}`}
                photos={[]}
                onUploaded={submitAttachment}
                multiple={false}
                compact
              />
            </div>
            {(issue.attachments?.length ?? 0) === 0 ? (
              <div className="text-xs text-muted-foreground italic flex items-center gap-1">
                <ImagePlus className="h-3 w-3" /> No photos yet
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                {issue.attachments!.map((a) => (
                  <a
                    key={a.id}
                    href={a.file_url}
                    target="_blank"
                    rel="noreferrer"
                    className="aspect-square rounded-md border overflow-hidden bg-muted block"
                  >
                    {a.file_type === "image" ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img src={a.file_url} alt={a.caption ?? "Attachment"} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">PDF</div>
                    )}
                  </a>
                ))}
              </div>
            )}
          </section>

          {/* Resolution (when resolved/closed) */}
          {(issue.status === "resolved" || issue.status === "closed") && (
            <section className="rounded-lg border bg-emerald-50/30 border-emerald-200 p-4 space-y-2">
              <div className="text-xs uppercase tracking-wide text-emerald-700">Resolution</div>
              {issue.resolution_root_cause && (
                <div className="text-xs"><span className="text-muted-foreground">Root cause:</span> {ROOT_CAUSE_LABEL[issue.resolution_root_cause]}</div>
              )}
              <p className="text-sm whitespace-pre-wrap">{issue.resolution_notes || "—"}</p>
              {issue.parts_cost > 0 && (
                <div className="text-xs"><span className="text-muted-foreground">Parts cost:</span> ₹{issue.parts_cost.toFixed(2)}{issue.parts_notes ? ` — ${issue.parts_notes}` : ""}</div>
              )}
              <div className="text-xs text-muted-foreground">
                Resolved {issue.resolved_at ? timeAgo(issue.resolved_at) : "—"} ·
                Took {formatDuration(issue.resolution_time_minutes)} ·
                {issue.sla_breached ? <span className="text-red-600 font-medium"> SLA breached</span> : <span className="text-emerald-700"> Met SLA</span>}
              </div>
            </section>
          )}

          {/* Activity — comments and status/ownership events merged into one
              conversation thread, newest first, with the composer pinned at
              the bottom. Previously these were two disconnected sections
              (an "Add comment" box above a separate ascending-order
              "Activity" timeline below it) — to see the latest update you
              had to scroll to the bottom of a different box than the one
              you'd type into. Event styling: resolved/reopened stand out
              (they're the moments that matter most), comments read as plain
              messages, everything else (assigned/claimed/routine status
              ticks) stays quiet so it doesn't compete for attention. */}
          <section className="rounded-lg border bg-card overflow-hidden">
            <div className="px-4 pt-3 pb-2 text-xs uppercase tracking-wide text-muted-foreground">Activity</div>
            <div className="max-h-[420px] overflow-y-auto px-4 pb-3 space-y-2">
              {[...(issue.events ?? [])].reverse().map((e) => {
                const isResolved = e.event_type === "resolved";
                const isReopened = e.event_type === "reopened";
                const isComment = e.event_type === "comment";
                const highlighted = isResolved || isReopened || isComment;
                return (
                  <div
                    key={e.id}
                    className={cn(
                      "rounded-md px-3 py-2",
                      isResolved && "bg-emerald-50 text-emerald-900",
                      isReopened && "bg-rose-50 text-rose-900",
                      isComment && "bg-muted/40",
                      !highlighted && "py-1",
                    )}
                  >
                    <div className={highlighted ? "text-sm" : "text-xs text-muted-foreground"}>
                      {e.message
                        ? renderMessageWithMentions(e.message, e.payload?.mentioned_user_ids as string[] | undefined, mentionRoster)
                        : e.event_type}
                    </div>
                    <div className={cn("text-xs mt-0.5", highlighted ? "opacity-70" : "text-muted-foreground")}>
                      {e.actor?.full_name ?? e.actor_label ?? "System"} · {timeAgo(e.created_at)}
                    </div>
                  </div>
                );
              })}
              {(issue.events ?? []).length === 0 && (
                <div className="text-xs text-muted-foreground italic py-1">No activity yet</div>
              )}
            </div>
            <div className="border-t p-3 space-y-2">
              <MentionTextarea
                value={comment}
                onChange={setComment}
                onMentionedIdsChange={setCommentMentionIds}
                roster={mentionRoster.filter((u) => u.id !== currentUser?.id)}
                rows={2}
                placeholder="Write an update… (@ to tag anyone)"
                maxLength={2000}
              />
              <div className="flex justify-end">
                <Button size="sm" onClick={submitComment} disabled={!comment.trim() || busy}>
                  <MessageSquare className="h-4 w-4 mr-1" /> Add comment
                </Button>
              </div>
            </div>
          </section>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
          {/* KPI score breakdown — the "why" behind the score, not just the
              number, so it's clear what to repeat or fix next time. */}
          {issue.kpi_points != null && (
            <section className="rounded-lg border bg-card p-4 space-y-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Score impact <span className="normal-case opacity-70">(KPI)</span></div>
              <div className={cn(
                "text-3xl font-bold",
                issue.kpi_points > 0 ? "text-emerald-600" : issue.kpi_points < 0 ? "text-red-600" : "text-muted-foreground",
              )}>
                {issue.kpi_points > 0 ? "+" : ""}{issue.kpi_points}
              </div>
              {issue.kpi_breakdown && issue.kpi_breakdown.length > 0 && (
                <div className="space-y-1 pt-1 border-t">
                  {issue.kpi_breakdown.map((line, i) => (
                    <div key={i} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{line.label}</span>
                      <span className={cn(
                        "font-medium tabular-nums",
                        line.delta > 0 ? "text-emerald-600" : line.delta < 0 ? "text-red-600" : "text-muted-foreground",
                      )}>
                        {line.delta > 0 ? "+" : ""}{line.delta}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* TAT extension history — kept at the top of the sidebar so TAT
              status/impact is immediately visible without scrolling. */}
          {extensions.length > 0 && (
            <section className="rounded-lg border bg-card p-4 space-y-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Deadline extensions <span className="normal-case opacity-70">(TAT)</span></div>
              <div className="space-y-3">
                {extensions.map((ext) => (
                  <div key={ext.id} className="text-xs space-y-1 border-l-2 pl-2" style={{ borderColor: ext.kpi_exempt ? "#059669" : "#dc2626" }}>
                    <div className="flex items-center justify-between">
                      <span className="font-medium">+{ext.added_hours}h — {TAT_REASON_LABEL[ext.reason_category]}</span>
                      <span className={cn("px-1.5 py-0.5 rounded-full ring-1 text-[10px] font-medium",
                        ext.kpi_exempt ? "bg-emerald-50 text-emerald-700 ring-emerald-200" : "bg-red-50 text-red-700 ring-red-200")}>
                        {ext.kpi_exempt ? "Doesn't count against score" : "Counts against score"}
                      </span>
                    </div>
                    <div className="text-muted-foreground">{ext.explanation}</div>
                    <div className="text-muted-foreground">{ext.requester?.full_name ?? "—"} · {timeAgo(ext.created_at)}</div>
                    {ext.pass_card_by && (
                      <div className="text-muted-foreground italic">Overridden by {ext.pass_card_by === currentUser?.id ? "you" : "admin/manager"}{ext.pass_card_note ? `: ${ext.pass_card_note}` : ""}</div>
                    )}
                    {canPassCard && (
                      <div className="flex gap-3 pt-1">
                        <button
                          type="button"
                          onClick={() => passCard(ext.id, true)}
                          disabled={busy || ext.kpi_exempt}
                          className="min-h-[28px] px-1 text-xs font-medium text-emerald-600 hover:underline disabled:opacity-40 disabled:no-underline"
                        >Don&apos;t count this against score</button>
                        <button
                          type="button"
                          onClick={() => passCard(ext.id, false)}
                          disabled={busy || !ext.kpi_exempt}
                          className="min-h-[28px] px-1 text-xs font-medium text-red-600 hover:underline disabled:opacity-40 disabled:no-underline"
                        >Count this against score</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Where */}
          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Where</div>
            <Detail icon={<MapPin className="h-3.5 w-3.5" />} label="Location" value={issue.location?.name ?? "—"} />
            {issue.floor?.name && <Detail label="Floor" value={issue.floor.name} />}
            {issue.space_unit?.code && (
              <Detail label="Space unit" value={`${issue.space_unit.code} · ${issue.space_unit.name}`} />
            )}
            {issue.asset?.name && (
              <Detail icon={<Server className="h-3.5 w-3.5" />} label="Asset"
                value={`${issue.asset.asset_code} · ${issue.asset.name}`} />
            )}
          </section>

          {/* Asset AMC context card */}
          {assetDetail && issue.asset_id && (
            <section className="rounded-lg border bg-card p-4 space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">Asset info</div>
                <Link
                  href={`/facility/assets/${issue.asset_id}`}
                  className="text-xs text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  Open <ExternalLink className="h-3 w-3" />
                </Link>
              </div>

              {(assetDetail.make || assetDetail.model) && (
                <div className="text-xs text-muted-foreground">{[assetDetail.make, assetDetail.model].filter(Boolean).join(" · ")}</div>
              )}

              {assetDetail.warranty_expiry && (
                <div className="text-xs flex items-center gap-1">
                  <span className="text-muted-foreground">Warranty:</span>
                  <span className={new Date(assetDetail.warranty_expiry) < new Date() ? "text-red-600" : "text-foreground"}>
                    {formatDate(assetDetail.warranty_expiry)}
                  </span>
                </div>
              )}

              {assetDetail.amc ? (
                <div className="space-y-1.5 pt-1 border-t">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={cn(
                      "text-[10px] px-1.5 py-0.5 rounded-full font-medium",
                      assetDetail.amc.amc_status === "active" ? "bg-green-100 text-green-700" :
                      assetDetail.amc.amc_status === "expiring" ? "bg-amber-100 text-amber-700" :
                      "bg-gray-100 text-gray-600",
                    )}>
                      {assetDetail.amc.amc_status === "active" ? "Under AMC" :
                       assetDetail.amc.amc_status === "expiring" ? "AMC Expiring" : "AMC Inactive"}
                    </span>
                    {assetDetail.amc.amc_end_date && (
                      <span className="text-xs text-muted-foreground">until {formatDate(assetDetail.amc.amc_end_date)}</span>
                    )}
                  </div>
                  {assetDetail.amc.vendor_name && (
                    <div className="text-xs"><span className="text-muted-foreground">Vendor:</span> {assetDetail.amc.vendor_name}</div>
                  )}
                  {assetDetail.amc.amc_helpline_number && (
                    <div className="text-xs flex items-center gap-1">
                      <Phone className="h-3 w-3 text-muted-foreground" />
                      <a href={`tel:${assetDetail.amc.amc_helpline_number}`} className="text-primary hover:underline">
                        {assetDetail.amc.amc_helpline_number}
                      </a>
                    </div>
                  )}
                  {assetDetail.amc.amc_contact_name && (
                    <div className="text-xs"><span className="text-muted-foreground">Contact:</span> {assetDetail.amc.amc_contact_name}</div>
                  )}
                  {assetDetail.amc.amc_contact_email && (
                    <div className="text-xs flex items-center gap-1">
                      <Mail className="h-3 w-3 text-muted-foreground" />
                      <a href={`mailto:${assetDetail.amc.amc_contact_email}`} className="text-primary hover:underline truncate">
                        {assetDetail.amc.amc_contact_email}
                      </a>
                    </div>
                  )}
                  {assetDetail.amc.amc_escalation_name && assetDetail.amc.amc_escalation_phone && (
                    <div className="text-xs">
                      <span className="text-muted-foreground">Escalation:</span>{" "}
                      {assetDetail.amc.amc_escalation_name} · {assetDetail.amc.amc_escalation_phone}
                    </div>
                  )}
                  {assetDetail.amc.amc_scope_covered && (
                    <div className="text-xs text-muted-foreground line-clamp-2 italic">{assetDetail.amc.amc_scope_covered}</div>
                  )}
                </div>
              ) : (
                <div className="text-xs text-muted-foreground pt-1 border-t">No AMC contract on file</div>
              )}

              {assetDetail.attention_notes && (
                <div className="rounded-md bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                  <AlertTriangle className="h-3 w-3 inline mr-1" />{assetDetail.attention_notes}
                </div>
              )}
              {assetDetail.notes && !assetDetail.attention_notes && (
                <div className="text-xs text-muted-foreground italic border-t pt-2 line-clamp-3">{assetDetail.notes}</div>
              )}

              {assetDetail.recent_issues.length > 0 && (
                <div className="pt-2 border-t space-y-1">
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Recent issues on this asset</div>
                  {assetDetail.recent_issues.map((ri) => (
                    <Link key={ri.id} href={`/facility/issues/${ri.id}`}
                      className="block text-xs hover:underline text-muted-foreground truncate"
                      onClick={() => pushTrailEntry({ href: `/facility/issues/${ri.id}`, label: ri.title })}
                    >
                      <code className="font-mono">{ri.issue_number}</code> — {ri.title}
                      <span className="ml-1 opacity-60">({timeAgo(ri.created_at)})</span>
                    </Link>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Assignment */}
          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Assignment</div>
            {issue.assignee?.full_name ? (
              <div className="text-sm font-medium">
                {issue.assignee.full_name}
                {isOwner && <span className="text-xs text-muted-foreground font-normal ml-1">(you)</span>}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground italic">Unassigned</div>
            )}
            {issue.assigned_at && <div className="text-xs text-muted-foreground">{timeAgo(issue.assigned_at)}</div>}
            {issue.claimed_at && (
              <div className="text-xs text-muted-foreground">Claimed {timeAgo(issue.claimed_at)}</div>
            )}
            {collaborators.length > 0 && (
              <div className="pt-1 space-y-1">
                <div className="text-xs text-muted-foreground">Collaborators:</div>
                {collaborators.map((c) => (
                  <div key={c.id} className="flex items-center justify-between text-sm">
                    <span>{c.user.full_name}</span>
                    <button
                      type="button"
                      onClick={() => removeCollaborator(c.user_id)}
                      disabled={busy}
                      className="text-xs text-red-500 hover:underline disabled:opacity-50"
                    >remove</button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setCollabOpen(true)}
              disabled={busy}
              className="text-xs text-primary hover:underline mt-1 disabled:opacity-50"
            >+ Add people</button>
          </section>

          {/* Nudge history */}
          {nudges.length > 0 && (
            <section className="rounded-lg border bg-card p-4 space-y-2">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Nudges</div>
              <div className="space-y-1.5">
                {nudges.slice(0, 6).map((n) => {
                  const label = { push: "Push", whatsapp: "WhatsApp", email: "Email" }[n.channel];
                  const statusStyle: Record<string, { icon: typeof Check; text: string; className: string }> = {
                    sent: { icon: Check, text: "Sent", className: "text-muted-foreground" },
                    delivered: { icon: CheckCheck, text: "Delivered", className: "text-blue-600" },
                    read: { icon: CheckCheck, text: "Read", className: "text-emerald-600" },
                    opened: { icon: CheckCheck, text: "Opened", className: "text-emerald-600" },
                    failed: { icon: X, text: "Failed", className: "text-red-600" },
                  };
                  const s = statusStyle[n.status] ?? statusStyle.sent;
                  const StatusIcon = s.icon;
                  return (
                    <div key={n.id} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{label} · {timeAgo(n.sent_at)}</span>
                      <span className={cn("flex items-center gap-1 font-medium", s.className)} title={n.error_message ?? undefined}>
                        <StatusIcon className="h-3 w-3" /> {s.text}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {issue.satisfaction_rating != null && (
            <section className="rounded-lg border bg-card p-4 space-y-1">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">Satisfaction</div>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <Star
                    key={n}
                    className={cn(
                      "h-4 w-4",
                      n <= (issue.satisfaction_rating ?? 0) ? "fill-amber-400 text-amber-500" : "text-muted-foreground/30",
                    )}
                  />
                ))}
                <span className="text-xs ml-1">{issue.satisfaction_rating}/5</span>
              </div>
              {issue.satisfaction_comment && (
                <p className="text-xs italic">&ldquo;{issue.satisfaction_comment}&rdquo;</p>
              )}
            </section>
          )}
        </aside>
      </div>

      {/* ───── Extend TAT dialog (owner only) ──────────────────────────────── */}
      <Dialog open={extendOpen} onOpenChange={setExtendOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Push back the deadline <span className="text-muted-foreground font-normal">(TAT)</span></DialogTitle>
            <DialogDescription>
              {2 - (issue.tat_extension_count ?? 0)} extension{2 - (issue.tat_extension_count ?? 0) === 1 ? "" : "s"} left on this ticket.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Additional hours</Label>
              <Input type="number" min={1} value={extendHours} onChange={(e) => setExtendHours(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Reason</Label>
              <Select value={extendReason} onValueChange={(v) => setExtendReason(v as FacilityTatReason)}>
                <SelectTrigger><SelectValue placeholder="Select a reason" /></SelectTrigger>
                <SelectContent>
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Outside your control</div>
                  {TAT_REASON_LIST_EXEMPT.map((r) => (
                    <SelectItem key={r} value={r}>{TAT_REASON_LABEL[r]}</SelectItem>
                  ))}
                  <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">Within your control</div>
                  {TAT_REASON_LIST_CONTROLLABLE.map((r) => (
                    <SelectItem key={r} value={r}>{TAT_REASON_LABEL[r]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {extendReason && (
                <p className="text-[11px] text-muted-foreground">
                  {TAT_REASON_LIST_EXEMPT.includes(extendReason)
                    ? "Outside your control — won't count against your KPI."
                    : "Within your control — counts against your KPI if still late."}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Explanation</Label>
              <Textarea value={extendExplanation} onChange={(e) => setExtendExplanation(e.target.value)} rows={3} placeholder="What's causing the delay?" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtendOpen(false)}>Cancel</Button>
            <Button onClick={submitExtend} disabled={extending || !extendReason || !extendExplanation.trim() || !extendHours}>
              {extending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Extend
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───── Resolve dialog ──────────────────────────────────────────────── */}
      <ResolveDialog
        open={resolveOpen}
        onOpenChange={setResolveOpen}
        busy={busy}
        onResolve={(payload) => changeStatus("resolved", payload)}
      />

      {/* ───── Assign dialog (override tier) ───────────────────────────────── */}
      <Dialog open={assignOpen} onOpenChange={setAssignOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign issue</DialogTitle>
            <DialogDescription>Pick a primary assignee or unassign.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            <button
              type="button"
              onClick={() => assignTo(null)}
              className="w-full text-left p-2 rounded-md border hover:bg-muted/40 text-sm"
            >Unassign</button>
            {assignees.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => assignTo(u.id)}
                className={cn(
                  "w-full text-left p-2 rounded-md border hover:bg-muted/40 text-sm flex items-center justify-between",
                  issue.assignee?.id === u.id && "ring-1 ring-[#015E65]",
                )}
              >
                <span>{u.full_name}</span>
                <span className="text-xs text-muted-foreground capitalize">{u.role.replace(/_/g, " ")}</span>
              </button>
            ))}
            {assignees.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No users found.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ───── Add collaborators dialog ───────────────────────────────────── */}
      <Dialog open={collabOpen} onOpenChange={setCollabOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add people</DialogTitle>
            <DialogDescription>Add collaborators who need to be involved in this issue.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 max-h-72 overflow-y-auto">
            {assignees
              .filter((u) => u.id !== issue.assigned_to && !collaborators.some((c) => c.user_id === u.id))
              .map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => addCollaborator(u.id)}
                className="w-full text-left p-2 rounded-md border hover:bg-muted/40 text-sm flex items-center justify-between"
              >
                <span>{u.full_name}</span>
                <span className="text-xs text-muted-foreground capitalize">{u.role.replace(/_/g, " ")}</span>
              </button>
            ))}
            {assignees.filter((u) => u.id !== issue.assigned_to && !collaborators.some((c) => c.user_id === u.id)).length === 0 && (
              <p className="text-xs text-muted-foreground italic">All available people are already assigned.</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Detail({ icon, label, value }: { icon?: React.ReactNode; label: string; value: string }) {
  return (
    <div className="text-sm flex items-start gap-1.5">
      {icon && <span className="text-muted-foreground mt-0.5">{icon}</span>}
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wide">{label}</div>
        <div className="truncate">{value}</div>
      </div>
    </div>
  );
}

function ResolveDialog({
  open, onOpenChange, busy, onResolve,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  busy: boolean;
  onResolve: (payload: { resolution_notes: string; resolution_root_cause: FacilityRootCause; parts_cost: number; parts_notes: string }) => void;
}) {
  const [notes, setNotes] = useState("");
  const [root, setRoot] = useState<FacilityRootCause>("hardware_failure");
  const [partsCost, setPartsCost] = useState("");
  const [partsNotes, setPartsNotes] = useState("");

  useEffect(() => {
    if (!open) return;
    setNotes(""); setRoot("hardware_failure"); setPartsCost(""); setPartsNotes("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Resolve issue</DialogTitle>
          <DialogDescription>Capture root cause and resolution.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs">Root cause</Label>
            <select
              value={root}
              onChange={(e) => setRoot(e.target.value as FacilityRootCause)}
              className="mt-1 w-full h-9 px-2 rounded-md border bg-background text-sm"
            >
              {ROOT_CAUSE_LIST.map((r) => (
                <option key={r} value={r}>{ROOT_CAUSE_LABEL[r]}</option>
              ))}
            </select>
          </div>
          <div>
            <Label className="text-xs">Resolution notes</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} className="mt-1" placeholder="What did you do to fix it?" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Parts cost (₹)</Label>
              <Input value={partsCost} onChange={(e) => setPartsCost(e.target.value)} type="number" inputMode="decimal" min={0} className="mt-1" />
            </div>
            <div>
              <Label className="text-xs">Parts notes</Label>
              <Input value={partsNotes} onChange={(e) => setPartsNotes(e.target.value)} className="mt-1" placeholder="e.g. patch cable, AP" />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            onClick={() => onResolve({
              resolution_notes: notes,
              resolution_root_cause: root,
              parts_cost: Number(partsCost) || 0,
              parts_notes: partsNotes,
            })}
            disabled={busy}
          >
            {busy ? <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Saving…</> : "Mark Resolved"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

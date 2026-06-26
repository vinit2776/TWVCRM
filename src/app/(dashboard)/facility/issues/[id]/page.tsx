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
  Phone, Mail, ExternalLink, ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { cn, formatDate } from "@/lib/utils";
import {
  PRIORITY_STYLES, STATUS_STYLES, ROOT_CAUSE_LIST, ROOT_CAUSE_LABEL,
  REPORTED_VIA_LABEL, formatDuration, timeAgo, timeUntil, nextStatusOptions,
} from "@/lib/facility-ui";
import { FacilityPhotoUpload, type FacilityUploadedPhoto } from "@/components/facility/photo-upload";
import type {
  FacilityIssue, FacilityIssueStatus, FacilityRootCause,
} from "@/types";

interface AssigneeOption { id: string; full_name: string; role: string }
interface Collaborator { id: string; user_id: string; user: { id: string; full_name: string; email: string; role: string } }
interface CurrentUser { id: string; full_name: string; role: string }

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
  const [resolveOpen, setResolveOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [assignees, setAssignees] = useState<AssigneeOption[]>([]);
  const [collaborators, setCollaborators] = useState<Collaborator[]>([]);
  const [collabOpen, setCollabOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [assetDetail, setAssetDetail] = useState<AssetDetail | null>(null);
  const assetFetchedRef = useRef<string | null>(null);

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

  useEffect(() => {
    fetchIssue();
    fetchCollaborators();
    fetch("/api/me")
      .then((r) => r.json())
      .then((j) => setCurrentUser(j ?? null))
      .catch(() => null);
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
  const allowedNext = useMemo(() => issue ? nextStatusOptions(issue.status) : [], [issue]);

  const isOverrideTier = OVERRIDE_ROLES.includes(currentUser?.role ?? "");
  const isOwner = !!currentUser && issue?.assigned_to === currentUser.id;
  const isUnowned = !!issue && !issue.assigned_to && (issue.status === "new" || issue.status === "reopened");
  const canAct = isOwner || isOverrideTier;

  const claimCountdownMs = useClaimCountdown(isUnowned ? issue?.claim_sla_target_at : null);

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

  const submitComment = async () => {
    if (!issue || !comment.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/facility/issues/${issue.id}/comment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: comment.trim() }),
      });
      if (!res.ok) throw new Error("Failed to add comment");
      setComment("");
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

  const slaChipClass = issue.sla_breached
    ? "bg-red-50 text-red-700 ring-red-200"
    : "bg-emerald-50 text-emerald-700 ring-emerald-200";

  const statusLabel = isUnowned ? "Unowned" : STATUS_STYLES[issue.status].label;
  const statusChipClass = isUnowned ? "bg-amber-50 text-amber-700 ring-amber-200" : STATUS_STYLES[issue.status].chip;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      {/* ───── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <code className="text-xs font-mono text-muted-foreground">{issue.issue_number}</code>
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", statusChipClass)}>
              {statusLabel}
            </span>
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1 inline-flex items-center gap-1", PRIORITY_STYLES[issue.priority].chip)}>
              <span className={cn("h-1.5 w-1.5 rounded-full", PRIORITY_STYLES[issue.priority].dot)} />
              {PRIORITY_STYLES[issue.priority].label}
            </span>
            {open && issue.sla_target_at && (
              <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1 inline-flex items-center", slaChipClass)}>
                <Clock className="h-2.5 w-2.5 mr-0.5" /> SLA {timeUntil(issue.sla_target_at)}
              </span>
            )}
          </div>
          <h1 className="text-base md:text-lg font-semibold mt-1 break-words">{issue.title}</h1>
        </div>
        <Button variant="ghost" size="icon" onClick={fetchIssue} disabled={loading} title="Refresh">
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>

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

      {/* ───── Action row ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {/* Unowned: Claim (any user) */}
        {isUnowned && (
          <Button size="sm" onClick={claimTicket} disabled={busy} className="bg-amber-600 hover:bg-amber-700 text-white">
            <User className="h-4 w-4 mr-1" /> Claim this ticket
          </Button>
        )}

        {/* Owned by someone else: Take over (any user) */}
        {!isUnowned && !isOwner && issue.assigned_to && open && (
          <Button size="sm" variant="outline" onClick={takeOver} disabled={busy}>
            <User className="h-4 w-4 mr-1" /> Take over
          </Button>
        )}

        {/* Work action buttons: owner or override tier only */}
        {canAct && (
          <>
            {allowedNext.includes("acknowledged") && (
              <Button size="sm" onClick={() => changeStatus("acknowledged")} disabled={busy}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Acknowledge
              </Button>
            )}
            {allowedNext.includes("in_progress") && (
              <Button size="sm" onClick={() => changeStatus("in_progress")} disabled={busy}>
                <Wrench className="h-4 w-4 mr-1" /> Start Work
              </Button>
            )}
            {allowedNext.includes("resolved") && (
              <Button size="sm" variant="default" onClick={() => setResolveOpen(true)} disabled={busy}>
                <CheckCircle2 className="h-4 w-4 mr-1" /> Resolve
              </Button>
            )}
            {allowedNext.includes("reopened") && (
              <Button size="sm" variant="outline" onClick={() => changeStatus("reopened")} disabled={busy}>
                Reopen
              </Button>
            )}
            {allowedNext.includes("closed") && (
              <Button size="sm" variant="outline" onClick={() => changeStatus("closed")} disabled={busy}>
                Close
              </Button>
            )}
          </>
        )}

        {/* Assign button: override tier (or unowned so anyone can assign-to-other via dialog) */}
        {isOverrideTier && (
          <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)} disabled={busy}>
            <User className="h-4 w-4 mr-1" /> {issue.assignee?.full_name ? "Reassign" : "Assign to…"}
          </Button>
        )}
      </div>

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

          {/* Comment box */}
          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Add comment</div>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              rows={2}
              placeholder="Update or note for this ticket…"
              maxLength={2000}
            />
            <div className="flex justify-end">
              <Button size="sm" onClick={submitComment} disabled={!comment.trim() || busy}>
                <MessageSquare className="h-4 w-4 mr-1" /> Add comment
              </Button>
            </div>
          </section>

          {/* Timeline */}
          <section className="rounded-lg border bg-card p-4 space-y-3">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Activity</div>
            <ol className="space-y-3">
              {(issue.events ?? []).map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-sm">
                  <span className="mt-1 h-1.5 w-1.5 rounded-full bg-muted-foreground/40 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{e.message ?? e.event_type}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {e.actor?.full_name ?? e.actor_label ?? "System"} · {timeAgo(e.created_at)}
                    </div>
                  </div>
                </li>
              ))}
              {(issue.events ?? []).length === 0 && (
                <li className="text-xs text-muted-foreground italic">No activity yet</li>
              )}
            </ol>
          </section>
        </div>

        {/* Sidebar */}
        <aside className="space-y-4">
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

          {/* Reporter */}
          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Reporter</div>
            <div className="text-sm">{issue.reporter?.full_name ?? issue.reporter_name ?? "—"}</div>
            <div className="text-xs text-muted-foreground space-y-0.5">
              {issue.reporter_email && <div>{issue.reporter_email}</div>}
              {issue.reporter_phone && <div>{issue.reporter_phone}</div>}
              <div>via {REPORTED_VIA_LABEL[issue.reported_via]}</div>
              <div>{timeAgo(issue.reported_at)}</div>
            </div>
          </section>

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

"use client";

/**
 * Facility Issue — detail / work page.
 *
 * Layout:
 *   Mobile: stacked. Header → big action buttons → details → timeline.
 *   Desktop: 2-column. Left = details + timeline; right = sidebar with assignment + SLA + actions.
 *
 * Key actions: Acknowledge / Start work / Resolve / Reopen / Assign / Comment / Add photo.
 */

import { useEffect, useMemo, useState, use } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowLeft, AlertTriangle, Loader2, MessageSquare, MapPin, User,
  Server, Clock, RefreshCw, CheckCircle2, Wrench, Star, ImagePlus,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
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

  useEffect(() => { fetchIssue(); fetchCollaborators(); /* eslint-disable-next-line */ }, [id]);

  // Load assignable users for the assign/collab dialog
  useEffect(() => {
    if (!assignOpen && !collabOpen) return;
    fetch("/api/facility/assignees")
      .then((r) => r.json())
      .then((j) => setAssignees((j.data || []).filter((u: AssigneeOption) => u.id)))
      .catch(() => setAssignees([]));
  }, [assignOpen, collabOpen]);

  const open = !!issue && ["new", "acknowledged", "in_progress", "reopened"].includes(issue.status);
  const allowedNext = useMemo(
    () => issue ? nextStatusOptions(issue.status) : [],
    [issue]
  );

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
    try {
      await fetch(`/api/facility/issues/${issue.id}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...p, phase: open ? "progress" : "report" }),
      });
      await fetchIssue();
    } catch {
      toast.error("Failed to attach photo");
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
      if (!res.ok) throw new Error("Assign failed");
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
            <span className={cn("text-[10px] px-1.5 py-0.5 rounded-full ring-1", STATUS_STYLES[issue.status].chip)}>
              {STATUS_STYLES[issue.status].label}
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

      {/* ───── Action row ──────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
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
        <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
          <User className="h-4 w-4 mr-1" /> {issue.assignee?.full_name ? "Reassign" : "Assign"}
        </Button>
      </div>

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

          {/* Resolution (when resolved) */}
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

          <section className="rounded-lg border bg-card p-4 space-y-2">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Assignment</div>
            {issue.assignee?.full_name ? (
              <div className="text-sm font-medium">{issue.assignee.full_name} <span className="text-xs text-muted-foreground font-normal">(primary)</span></div>
            ) : (
              <div className="text-sm text-muted-foreground italic">Unassigned</div>
            )}
            {issue.assigned_at && <div className="text-xs text-muted-foreground">{timeAgo(issue.assigned_at)}</div>}
            {collaborators.length > 0 && (
              <div className="pt-1 space-y-1">
                <div className="text-xs text-muted-foreground">Collaborators:</div>
                {collaborators.map((c) => (
                  <div key={c.id} className="flex items-center justify-between text-sm">
                    <span>{c.user.full_name}</span>
                    <button
                      type="button"
                      onClick={() => removeCollaborator(c.user_id)}
                      className="text-xs text-red-500 hover:underline"
                    >remove</button>
                  </div>
                ))}
              </div>
            )}
            <button
              type="button"
              onClick={() => setCollabOpen(true)}
              className="text-xs text-primary hover:underline mt-1"
            >+ Add people</button>
          </section>

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

      {/* ───── Assign dialog ───────────────────────────────────────────────── */}
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
                  issue.assigned_to === u.id && "ring-1 ring-[#015E65]",
                )}
              >
                <span>{u.full_name}</span>
                <span className="text-xs text-muted-foreground capitalize">{u.role.replace("_", " ")}</span>
              </button>
            ))}
            {assignees.length === 0 && (
              <p className="text-xs text-muted-foreground italic">No IT technicians or managers found.</p>
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
                <span className="text-xs text-muted-foreground capitalize">{u.role.replace("_", " ")}</span>
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

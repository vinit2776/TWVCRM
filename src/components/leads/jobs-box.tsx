"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PersonName } from "@/components/shared/person-name";
import { useCurrentUser } from "@/providers/current-user-provider";
import { groupJobs, type JobRow } from "@/lib/job-groups";
import { JOB_KIND_LABELS, type JobKind } from "@/lib/handover-jobs";
import { formatDate } from "@/lib/utils";

const leadName = (j: JobRow) => `${j.lead?.first_name ?? ""} ${j.lead?.last_name ?? ""}`.trim() || "A lead";

function Brief({ job }: { job: JobRow }) {
  const b = job.brief;
  if (!b?.discussed && !b?.proposal_kind) return null;
  return (
    <div className="mt-1 space-y-0.5 rounded-md bg-muted/40 px-2 py-1.5 text-xs text-muted-foreground">
      {b.proposal_kind && <div><b className="text-foreground">Proposal:</b> {b.proposal_kind}</div>}
      {b.discussed && <div><b className="text-foreground">Discussed:</b> {b.discussed}</div>}
    </div>
  );
}

/**
 * Who is doing what on the leads you hand over or are handed: what you need to do, what you are
 * waiting on others for, and what others finished for you. Refreshes when the window is focused,
 * because a job often finishes in another tab. Behind the hand-over switch.
 */
export function JobsBox() {
  const { user } = useCurrentUser();
  const [jobs, setJobs] = useState<JobRow[] | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const load = useCallback(() => {
    fetch("/api/leads/jobs")
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => json?.data && setJobs(json.data as JobRow[]))
      .catch(() => {});
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [load]);

  if (!user?.id || !jobs) return null;
  const g = groupJobs(jobs, user.id);
  if (g.you.length + g.waiting.length + g.done.length === 0) return null;

  const finish = async (job: JobRow) => {
    if (job.kind === "other" && !note.trim()) return void toast.error("Say what you did, so the person who handed it over knows");
    const res = await fetch(`/api/tasks/${job.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done", completion_note: note.trim() || undefined }),
    });
    if (!res.ok) return void toast.error((await res.json().catch(() => ({}))).error ?? "Could not finish it");
    toast.success("Done. The person who handed it over will see it.");
    setNoteFor(null);
    setNote("");
    load();
  };
  const takeBack = async (job: JobRow) => {
    const res = await fetch(`/api/tasks/${job.id}`, { method: "DELETE" });
    if (!res.ok) return void toast.error((await res.json().catch(() => ({}))).error ?? "Could not take it back");
    load();
  };

  const row = (j: JobRow, actions: React.ReactNode) => (
    <li key={j.id} className="space-y-1 border-t py-2.5 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <b>{j.kind === "other" && j.title ? j.title : (JOB_KIND_LABELS[j.kind as JobKind] ?? j.kind)}</b> · <Link href={`/leads/${j.lead?.id}/activity`} className="text-primary hover:underline">{leadName(j)}</Link>
          {j.due_date && <span className="text-muted-foreground"> · by {formatDate(j.due_date)}</span>}
        </div>
        <div className="flex flex-wrap gap-2">{actions}</div>
      </div>
      <Brief job={j} />
    </li>
  );
  const openLead = (j: JobRow) => (
    <Button asChild size="sm" variant="outline" className="h-9">
      <Link href={`/leads/${j.lead?.id}/activity`}>Open lead</Link>
    </Button>
  );

  return (
    <section className="space-y-3 rounded-lg border p-4">
      <h2 className="text-lg font-semibold">Who is doing what</h2>
      {g.you.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-primary">You need to do</div>
          <ul className="text-sm">
            {g.you.map((j) =>
              row(
                j,
                <>
                  {j.giver && j.giver.id !== user.id && (
                    <span className="self-center text-xs text-muted-foreground">from <PersonName id={j.giver.id} name={j.giver.full_name} /></span>
                  )}
                  {openLead(j)}
                  {j.kind === "send_proposal" ? (
                    <>
                      <span className="self-center text-xs text-muted-foreground">finishes when the proposal is sent</span>
                      <Button size="sm" className="h-9" asChild>
                        <a href={`/leads/${j.lead?.id}?tab=proposals&newProposal=1&job=${j.id}`} target="_blank" rel="noopener noreferrer">Make the proposal</a>
                      </Button>
                    </>
                  ) : noteFor === j.id ? (
                    <>
                      <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder={j.kind === "other" ? "What did you do?" : "Note (optional)"} className="h-9 w-56" />
                      <Button size="sm" className="h-9" onClick={() => finish(j)}>Done</Button>
                    </>
                  ) : (
                    <>
                      {(j.kind === "call_back" || j.kind === "book_tour") && (
                        <span className="self-center text-xs text-muted-foreground">
                          {j.kind === "call_back" ? "finishes when you log a call" : "finishes when you book the tour"}
                        </span>
                      )}
                      <Button size="sm" className="h-9" variant={j.kind === "call_back" || j.kind === "book_tour" ? "outline" : "default"} onClick={() => (setNoteFor(j.id), setNote(""))}>Mark done</Button>
                    </>
                  )}
                </>,
              ),
            )}
          </ul>
        </div>
      )}
      {g.waiting.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-amber-700">Waiting on others</div>
          <ul className="text-sm">
            {g.waiting.map((j) =>
              row(
                j,
                <>
                  <span className="self-center text-xs text-muted-foreground">with <PersonName id={j.assignee?.id} name={j.assignee?.full_name} /> since {formatDate(j.created_at)}</span>
                  {openLead(j)}
                  <Button size="sm" variant="ghost" className="h-9 text-muted-foreground" onClick={() => takeBack(j)}>Take back</Button>
                </>,
              ),
            )}
          </ul>
        </div>
      )}
      {g.done.length > 0 && (
        <div>
          <div className="text-sm font-semibold text-emerald-700">Done by others</div>
          <ul className="text-sm">
            {g.done.map((j) =>
              row(
                j,
                <span className="self-center text-xs text-muted-foreground">
                  <PersonName id={j.assignee?.id} name={j.assignee?.full_name} /> · {j.completed_at ? formatDate(j.completed_at) : ""}
                  {j.completion_note ? ` · ${j.completion_note}` : ""}
                </span>,
              ),
            )}
          </ul>
        </div>
      )}
    </section>
  );
}

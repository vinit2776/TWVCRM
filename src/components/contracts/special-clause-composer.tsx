"use client";

import { useState } from "react";
import { Loader2, Sparkles, CheckCircle2, AlertTriangle, HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export interface ClauseReport {
  restated_intent: string;
  kept: string[];
  added: string[];
  topics_checked: string[];
  rounds: number;
}

/** What the server needs to store a vetted clause (matches the submit schema). */
export interface VettedClause {
  intent: string;
  reason: string;
  clause_text: string;
  review_token: string;
  report: ClauseReport;
}

interface Props {
  /** Which agreement family this clause is for; picks the numbering and conflict check. */
  kind?: "membership" | "virtual_office";
  /** Real contract values the clause must not contradict (rent, term, lock-in…). */
  facts: Record<string, string>;
  /** Emits the vetted clause, or null whenever the inputs change after a review. */
  onChange: (value: VettedClause | null) => void;
  /** Manager/admin authors approve their own clause; reps send it for approval. */
  selfApproves: boolean;
  initialIntent?: string;
  initialReason?: string;
  /** Approver's feedback on the previous revision, shown beside the form. */
  feedback?: string;
  previousText?: string;
}

type DraftResponse =
  | { status: "questions"; questions: string[] }
  | { status: "drafted"; clause_text: string; report: ClauseReport; review_token: string }
  | { status: "failed"; problems: string[] };

export function SpecialClauseComposer({ kind = "membership", facts, onChange, selfApproves, initialIntent = "", initialReason = "", feedback, previousText }: Props) {
  const [intent, setIntent] = useState(initialIntent);
  const [reason, setReason] = useState(initialReason);
  const [answers, setAnswers] = useState("");
  const [tweak, setTweak] = useState("");
  const [loading, setLoading] = useState(false);
  const [questions, setQuestions] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [drafted, setDrafted] = useState<{ text: string; report: ClauseReport } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => {
    if (drafted) {
      setDrafted(null);
      onChange(null);
    }
  };

  async function runDraft(adjust?: string) {
    setError(null);
    setProblems([]);
    if (intent.trim().length < 10 || reason.trim().length < 10) {
      setError("Describe what was agreed and why, a sentence each.");
      return;
    }
    const fullIntent = answers.trim() ? `${intent.trim()}\n\nClarifications: ${answers.trim()}` : intent.trim();
    setLoading(true);
    try {
      const res = await fetch("/api/special-clause/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          intent: fullIntent,
          reason: reason.trim(),
          facts,
          feedback: [feedback, adjust].filter(Boolean).join("\nAuthor's adjustment: ") || undefined,
          previous_text: drafted?.text ?? previousText,
        }),
      });
      const json = (await res.json()) as DraftResponse & { error?: string };
      if (!res.ok) {
        setError(json.error ?? "Couldn't review the clause. Try again.");
        return;
      }
      if (json.status === "questions") {
        setQuestions(json.questions);
        setDrafted(null);
        onChange(null);
      } else if (json.status === "failed") {
        setProblems(json.problems);
        setDrafted(null);
        onChange(null);
      } else {
        setQuestions([]);
        setTweak("");
        setDrafted({ text: json.clause_text, report: json.report });
        onChange({ intent: fullIntent, reason: reason.trim(), clause_text: json.clause_text, review_token: json.review_token, report: json.report });
        toast.success("Clause drafted and reviewed");
      }
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3">
      {feedback && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-medium">Changes requested</p>
          <p className="whitespace-pre-wrap">{feedback}</p>
        </div>
      )}

      <div className="space-y-1.5">
        <Label>What was agreed with the customer (plain words)</Label>
        <Textarea
          rows={3}
          value={intent}
          onChange={(e) => { setIntent(e.target.value); invalidate(); }}
          placeholder="e.g. They can use the Cabin 4 meeting room for 10 free hours each month"
        />
      </div>
      <div className="space-y-1.5">
        <Label>Why is this needed (internal, never printed)</Label>
        <Textarea
          rows={2}
          value={reason}
          onChange={(e) => { setReason(e.target.value); invalidate(); }}
          placeholder="e.g. Offered in place of a rent discount, agreed with Vinit"
        />
      </div>

      {questions.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
          <p className="font-medium flex items-center gap-1.5"><HelpCircle className="h-4 w-4" />Claude needs a bit more before it can word this safely</p>
          <ul className="list-disc pl-5">{questions.map((q) => <li key={q}>{q}</li>)}</ul>
          <Textarea rows={2} value={answers} onChange={(e) => setAnswers(e.target.value)} placeholder="Your answers" className="bg-white" />
        </div>
      )}

      {problems.length > 0 && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <p className="font-medium">The reviewer couldn&apos;t sign off on a draft. Reword the request and try again.</p>
          <ul className="list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      )}

      {error && <p className="text-sm text-red-600">{error}</p>}

      {!drafted && (
        <Button type="button" variant="outline" onClick={() => runDraft()} disabled={loading}>
          {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Sparkles className="mr-2 h-4 w-4" />}
          {questions.length > 0 ? "Draft with my answers" : "Draft and review with Claude"}
        </Button>
      )}

      {drafted && (
        <div className="space-y-2 rounded-md border bg-muted/30 p-3">
          <p className="text-xs text-muted-foreground">Clause as it will print</p>
          <p className="whitespace-pre-wrap text-sm leading-relaxed">{drafted.text}</p>
          <div className="space-y-1 border-t pt-2 text-xs">
            <p className="flex items-center gap-1.5 text-green-700">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Reviewed against your request and the contract ({drafted.report.rounds} round{drafted.report.rounds === 1 ? "" : "s"})
            </p>
            {drafted.report.kept.length > 0 && <p className="text-muted-foreground">Kept: {drafted.report.kept.join("; ")}</p>}
            {drafted.report.added.length > 0 && (
              <p className="flex items-start gap-1.5 text-amber-700">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>Added by AI beyond what you asked, please confirm: {drafted.report.added.join("; ")}</span>
              </p>
            )}
            {drafted.report.topics_checked.length > 0 && <p className="text-muted-foreground">Checked against: {drafted.report.topics_checked.join(", ")}</p>}
          </div>
          <div className="flex gap-2 pt-1">
            <Input value={tweak} onChange={(e) => setTweak(e.target.value)} placeholder="Want a change? Tell Claude what to adjust" className="h-8 text-xs" />
            <Button type="button" variant="outline" size="sm" disabled={loading || tweak.trim().length < 3} onClick={() => runDraft(tweak.trim())}>
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Redraft"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {selfApproves
              ? "As a manager/admin, your clause is approved when you save it."
              : "A manager or admin must approve this before the agreement can be sent."}
          </p>
        </div>
      )}
    </div>
  );
}

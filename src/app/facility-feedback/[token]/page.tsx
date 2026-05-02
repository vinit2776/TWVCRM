"use client";

/**
 * Public satisfaction rating page — keyed by satisfaction_token.
 * No authentication required. Members get the link via WhatsApp/email
 * after their issue is resolved.
 */

import { use, useEffect, useState } from "react";
import { Star, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

type IssueInfo = {
  issue_number: string;
  title: string;
  status: string;
  resolved_at: string | null;
  location_name: string | null;
  already_rated: boolean;
  current_rating?: number | null;
};

export default function FacilityFeedbackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [issue, setIssue] = useState<IssueInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [reopened, setReopened] = useState(false);

  useEffect(() => {
    fetch(`/api/facility/satisfaction/${token}`)
      .then((r) => r.json().then((j) => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) setError(j.error || "Invalid link");
        else setIssue(j.data);
      })
      .finally(() => setLoading(false));
  }, [token]);

  const submit = async () => {
    if (!rating) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/facility/satisfaction/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment: comment.trim() }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to submit");
      setDone(true);
      setReopened(!!json.reopened);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error || !issue) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full text-center space-y-3">
          <h1 className="text-xl font-semibold">Link not found</h1>
          <p className="text-sm text-muted-foreground">{error || "This rating link is invalid or has expired."}</p>
        </div>
      </div>
    );
  }

  if (done || issue.already_rated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
        <div className="max-w-md w-full bg-card border rounded-lg p-6 text-center space-y-3">
          <CheckCircle2 className="h-12 w-12 mx-auto text-emerald-500" />
          <h1 className="text-xl font-semibold">Thank you!</h1>
          <p className="text-sm text-muted-foreground">
            {reopened
              ? "We've reopened this ticket so the team can take another look."
              : "Your feedback has been recorded. It helps us improve."}
          </p>
          <p className="text-xs text-muted-foreground pt-2">Issue {issue.issue_number}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-muted/30">
      <div className="max-w-md w-full bg-card border rounded-lg p-6 space-y-4">
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">{issue.location_name}</div>
          <h1 className="text-lg font-semibold">{issue.title}</h1>
          <div className="text-xs text-muted-foreground">Issue {issue.issue_number}</div>
        </div>

        <div className="border-t pt-4 space-y-3">
          <p className="text-sm">How would you rate the resolution?</p>
          <div className="flex items-center justify-center gap-2">
            {[1, 2, 3, 4, 5].map((n) => {
              const filled = (hover || rating) >= n;
              return (
                <button
                  key={n}
                  type="button"
                  onMouseEnter={() => setHover(n)}
                  onMouseLeave={() => setHover(0)}
                  onClick={() => setRating(n)}
                  className="p-1"
                  aria-label={`Rate ${n} stars`}
                >
                  <Star className={cn("h-9 w-9 transition", filled ? "fill-amber-400 text-amber-500" : "text-muted-foreground/30")} />
                </button>
              );
            })}
          </div>
          <div className="text-center text-xs text-muted-foreground h-4">
            {rating === 1 && "Very poor"}
            {rating === 2 && "Poor — we'll reopen this"}
            {rating === 3 && "OK"}
            {rating === 4 && "Good"}
            {rating === 5 && "Excellent"}
          </div>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            placeholder="Anything else we should know? (optional)"
            maxLength={2000}
          />
          <Button onClick={submit} disabled={!rating || submitting} className="w-full">
            {submitting ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Submitting…</> : "Submit feedback"}
          </Button>
        </div>
      </div>
    </div>
  );
}

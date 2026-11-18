"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { CheckCircle2, Loader2 } from "lucide-react";

interface VoProposalView {
  proposal_number: string;
  title: string;
  status: string;
  items: { description: string; quantity: number; unit_price: number; total: number }[];
  tax_percentage: number;
  tax_amount: number;
  total_amount: number;
  term_months: number | null;
  expires_at: string | null;
  customer_name: string | null;
  blocked_reason: string | null;
  /** Frozen library clauses this proposal was sent with; absent or empty when the terms library is off. */
  terms?: { code: string; text: string }[] | null;
}

const inr = (n: number) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0 }).format(n);

type Action = "accept" | "request_changes" | "decline";
const DONE_TEXT: Record<Action, string> = {
  accept: "Thank you. You have accepted this proposal. We will contact you shortly for the signer details.",
  request_changes: "Thank you. We have your requested changes and will send you a revised proposal.",
  decline: "Understood. We have recorded that you have declined this proposal.",
};

export default function VoProposalPage() {
  const { token } = useParams();
  const [data, setData] = useState<VoProposalView | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState("");
  const [asking, setAsking] = useState<Action | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState<Action | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/public/vo-proposal/${token}`);
        const json = await res.json();
        if (!res.ok) setError(json.error || "Invalid link");
        else setData(json.data);
      } catch {
        setError("Failed to load");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  async function respond(action: Action) {
    setSubmitting(true);
    setError("");
    try {
      const res = await fetch(`/api/public/vo-proposal/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, note: note.trim() || undefined }),
      });
      const json = await res.json();
      if (!res.ok) setError(json.error || "Something went wrong");
      else setDone(action);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }
  if (!data) {
    return <div className="mx-auto max-w-md p-8 text-center text-gray-700">{error || "Invalid link"}</div>;
  }

  return (
    <div className="mx-auto max-w-xl p-4 py-8">
      <div className="rounded-lg border bg-white shadow-sm">
        <div className="rounded-t-lg bg-[#015E65] px-6 py-5">
          <h1 className="text-lg font-semibold text-white">The WorkVilla</h1>
          <p className="text-xs text-[#00AE6C]">Virtual Office proposal {data.proposal_number}</p>
        </div>
        <div className="space-y-4 p-6">
          <p className="text-sm text-gray-700">
            {data.customer_name ? `Dear ${data.customer_name},` : "Hello,"} here is your proposal: <strong>{data.title}</strong>
            {data.term_months ? ` (${data.term_months}-month term)` : ""}.
          </p>
          <table className="w-full text-sm">
            <tbody>
              {data.items.map((it, i) => (
                <tr key={i} className="border-b">
                  <td className="py-2 pr-2">{it.description}</td>
                  <td className="py-2 text-right">{inr(it.total)}</td>
                </tr>
              ))}
              <tr>
                <td className="pt-2 text-gray-500">GST ({data.tax_percentage}%)</td>
                <td className="pt-2 text-right">{inr(data.tax_amount)}</td>
              </tr>
              <tr className="font-semibold">
                <td className="pt-2">Total</td>
                <td className="pt-2 text-right">{inr(data.total_amount)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-gray-500">No security deposit applies to this proposal.</p>
          {data.terms && data.terms.length > 0 && (
            <div className="space-y-1 border-t pt-3">
              <h2 className="text-sm font-semibold text-gray-800">Terms</h2>
              <ol className="list-decimal space-y-1 pl-5 text-xs text-gray-600">
                {data.terms.map((t) => (
                  <li key={t.code}>{t.text}</li>
                ))}
              </ol>
            </div>
          )}
          {data.expires_at && (
            <p className="text-xs text-gray-500">
              Valid until {new Date(data.expires_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}.
            </p>
          )}

          {done ? (
            <div className="flex items-start gap-2 rounded-md bg-green-50 p-3 text-sm text-green-800">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{DONE_TEXT[done]}</span>
            </div>
          ) : data.blocked_reason ? (
            <div className="rounded-md bg-amber-50 p-3 text-sm text-amber-800">{data.blocked_reason}</div>
          ) : (
            <div className="space-y-3">
              {asking && (
                <textarea
                  className="w-full rounded-md border p-2 text-sm"
                  rows={3}
                  placeholder={asking === "request_changes" ? "What would you like changed?" : "Anything you would like to tell us (optional)"}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              )}
              {error && <p className="text-sm text-red-600">{error}</p>}
              <div className="flex flex-wrap gap-2">
                {asking ? (
                  <>
                    <button
                      className="rounded-md bg-[#015E65] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
                      disabled={submitting || (asking === "request_changes" && !note.trim())}
                      onClick={() => respond(asking)}
                    >
                      {submitting ? "Sending..." : "Confirm"}
                    </button>
                    <button className="rounded-md border px-4 py-2 text-sm" disabled={submitting} onClick={() => setAsking(null)}>
                      Back
                    </button>
                  </>
                ) : (
                  <>
                    <button className="rounded-md bg-[#015E65] px-4 py-2 text-sm font-medium text-white" onClick={() => setAsking("accept")}>
                      Accept proposal
                    </button>
                    <button className="rounded-md border px-4 py-2 text-sm" onClick={() => setAsking("request_changes")}>
                      Request changes
                    </button>
                    <button className="rounded-md border px-4 py-2 text-sm text-red-700" onClick={() => setAsking("decline")}>
                      Decline
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { NOC_CLAUSES } from "@/lib/noc/rules";
import { REQUIRED_TICKS, serviceTerms } from "@/lib/noc/acceptance";

interface View {
  reference: string; company: string; centre: string; purposeLabel: string; address: string;
  fee: { excl: number; tax: number; total: number }; taxPercentage: number; validUntilLabel: string;
  status: string; accepted: boolean; acceptedBy: string | null; paid: boolean;
  payment: { amount: number; paidAt: string; reference: string | null; invoiceNumber: string | null } | null;
  codeDestination: string | null; payUrl: string | null; linkProblem: string | null; customerName: string;
}

const inr = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n);

/**
 * The customer's NOC page (no sign-in; the long token in the address is the key). Reads the fee and the paragraphs
 * that will be printed in the certificate, takes the acceptance (every box ticked, name, designation, emailed code),
 * then sends the customer on to the payment gateway. When the gateway returns here it waits for the payment to land
 * and then shows the confirmation.
 */
export default function NocPublicPage() {
  const { token } = useParams<{ token: string }>();
  const search = useSearchParams();
  const returnedFromGateway = search.get("razorpay_callback") === "true";
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (poll = false) => {
    const res = await fetch(`/api/public/noc/${token}${poll ? "?poll=1" : ""}`, { cache: "no-store" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { setError(j.error || "This link is not valid."); return null; }
    setView(j.data as View);
    return j.data as View;
  }, [token]);

  useEffect(() => { load().finally(() => setLoading(false)); }, [load]);

  // Back from the gateway: wait for the payment to be recorded (it arrives by the gateway's own message to us).
  const waiting = returnedFromGateway && !!view && view.accepted && !view.paid;
  useEffect(() => {
    if (!waiting) return;
    let n = 0;
    const t = setInterval(async () => {
      n += 1;
      const v = await load(true);
      if (v?.paid || n >= 40) clearInterval(t);
    }, 5000);
    return () => clearInterval(t);
  }, [waiting, load]);

  if (loading) return <Shell><div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-[#015E65]" /></div></Shell>;
  if (error || !view) return <Shell><p className="py-12 text-center font-medium text-red-600">{error || "This link is not valid."}</p></Shell>;

  if (view.paid) return <Shell><Confirmation v={view} /></Shell>;
  if (waiting) return (
    <Shell>
      <div className="py-10 text-center">
        <Loader2 className="mx-auto mb-4 h-12 w-12 animate-spin text-[#015E65]" />
        <h2 className="text-xl font-bold text-[#015E65]">Confirming your payment…</h2>
        <p className="mt-2 text-gray-600">This usually takes a few seconds. You can keep this page open.</p>
      </div>
    </Shell>
  );
  if (view.accepted) return <Shell><Accepted v={view} /></Shell>;
  return <Shell><Accept v={view} token={token} onDone={(d) => { if (d.payUrl) window.location.href = d.payUrl; else load(); }} /></Shell>;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 p-4">
      <div className="mx-auto max-w-xl">
        <div className="rounded-t-xl bg-[#015E65] p-6 text-center text-white">
          <h1 className="text-2xl font-bold">The WorkVilla</h1>
          <p className="mt-1 flex items-center justify-center gap-1 text-sm text-[#00AE6C]"><ShieldCheck className="h-4 w-4" />No Objection Certificate</p>
        </div>
        <div className="rounded-b-xl bg-white p-6 shadow">{children}</div>
        <p className="mt-4 text-center text-xs text-gray-400">Sree Design Infrastructure Pvt Ltd · The WorkVilla</p>
      </div>
    </div>
  );
}

function Summary({ v }: { v: View }) {
  return (
    <>
      <div className="mb-4">
        <p className="font-semibold text-gray-900">{v.company}</p>
        <p className="text-sm text-gray-600">NOC for {v.purposeLabel} at {v.centre} · valid till {v.validUntilLabel}</p>
      </div>
      <div className="mb-5 rounded-lg border p-4 text-sm">
        <div className="flex justify-between py-0.5"><span className="text-gray-600">NOC fee</span><span>{inr(v.fee.excl)}</span></div>
        <div className="flex justify-between py-0.5"><span className="text-gray-600">GST {v.taxPercentage}%</span><span>{inr(v.fee.tax)}</span></div>
        <div className="mt-1 flex justify-between border-t pt-2 font-bold"><span>To pay</span><span>{inr(v.fee.total)}</span></div>
      </div>
    </>
  );
}

function Accept({ v, token, onDone }: { v: View; token: string; onDone: (d: { payUrl: string | null }) => void }) {
  const paragraphs = [...NOC_CLAUSES, serviceTerms(v.validUntilLabel)];
  const [ticks, setTicks] = useState<boolean[]>(() => new Array(REQUIRED_TICKS).fill(false));
  const [name, setName] = useState("");
  const [designation, setDesignation] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const allTicked = ticks.every(Boolean);
  const ready = allTicked && name.trim().length >= 3 && designation.trim().length > 0 && /^\d{6}$/.test(code.trim());

  async function sendCode() {
    setBusy(true); setErr(""); setMsg("");
    try {
      const res = await fetch(`/api/public/noc/${token}/send-code`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void setErr(j.error || "We could not send the code.");
      setSentTo(j.data.sentTo); setMsg(`We emailed a 6-digit code to ${j.data.sentTo}. It works for ${j.data.minutes} minutes.`);
    } finally { setBusy(false); }
  }

  async function accept() {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`/api/public/noc/${token}/accept`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code, name, designation, ticks }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void setErr(j.error || "We could not record your acceptance.");
      onDone({ payUrl: j.data.payUrl });
    } finally { setBusy(false); }
  }

  return (
    <>
      <Summary v={v} />
      <p className="mb-2 text-sm font-semibold text-gray-800">Please read. These paragraphs are printed in your NOC.</p>
      <div className="mb-4 space-y-2">
        {paragraphs.map((p, i) => (
          <label key={i} className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-[13px] leading-snug text-gray-700">
            {i === NOC_CLAUSES.length && <span className="sr-only">Service terms</span>}
            <input type="checkbox" className="mt-1 h-4 w-4 shrink-0" checked={ticks[i]} onChange={(e) => setTicks((t) => t.map((x, k) => (k === i ? e.target.checked : x)))} />
            <span>{i === NOC_CLAUSES.length && <b className="block text-gray-900">Service terms (not printed in the NOC)</b>}{p}</span>
          </label>
        ))}
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-semibold text-gray-700">Your full name
          <input className="mt-1 w-full rounded-md border px-3 py-2 text-sm font-normal" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
        </label>
        <label className="text-xs font-semibold text-gray-700">Designation in the company
          <input className="mt-1 w-full rounded-md border px-3 py-2 text-sm font-normal" value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="for example Director" />
        </label>
      </div>

      <div className="mb-4 rounded-lg border bg-gray-50 p-3">
        <p className="mb-2 text-xs text-gray-600">To confirm it is you, we email a code to {v.codeDestination ? <b>{v.codeDestination}</b> : "the email on your contract"}.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={sendCode} disabled={busy || !v.codeDestination} title={`Emails a 6-digit code to ${v.codeDestination ?? "the email on your contract"}. Nothing else happens.`} className="rounded-md border border-[#015E65] px-3 py-1.5 text-sm font-semibold text-[#015E65] disabled:opacity-50">{sentTo ? "Send a new code" : "Email me a code"}</button>
          <input className="w-36 rounded-md border px-3 py-1.5 text-sm tracking-widest" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        </div>
        <p className="mt-2 text-xs text-gray-500">{sentTo ? "Sends another code and the earlier one stops working." : `Emails a 6-digit code to ${v.codeDestination ?? "the email on your contract"}. Nothing else happens yet.`}</p>
        {msg && <p className="mt-1 text-xs text-emerald-700">{msg}</p>}
        {!v.codeDestination && <p className="mt-2 text-xs text-red-600">We have no email on record for this contract. Please contact The WorkVilla.</p>}
      </div>

      {err && <p className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
      <button type="button" onClick={accept} disabled={!ready || busy} className="flex w-full items-center justify-center gap-2 rounded-lg bg-[#015E65] px-4 py-3 font-semibold text-white disabled:opacity-40">
        {busy && <Loader2 className="h-4 w-4 animate-spin" />}Accept and pay {inr(v.fee.total)}
      </button>
      <p className="mt-2 text-center text-xs text-gray-500">This records that you have read and accept the paragraphs above (with the time and your device) and then takes you to the secure payment page. You are not charged until you pay there.</p>
    </>
  );
}

function Accepted({ v }: { v: View }) {
  return (
    <>
      <Summary v={v} />
      <p className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Thank you{v.acceptedBy ? `, ${v.acceptedBy}` : ""}. Your acceptance is recorded.</p>
      {v.payUrl ? (
        <>
          <a href={v.payUrl} className="block w-full rounded-lg bg-[#015E65] px-4 py-3 text-center font-semibold text-white">Continue to payment · {inr(v.fee.total)}</a>
          <p className="mt-2 text-center text-xs text-gray-500">Opens the secure payment page for {inr(v.fee.total)}. You are charged only when you complete the payment there.</p>
        </>
      ) : (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{v.linkProblem ?? "The payment page is not ready yet. Please contact The WorkVilla."}</p>
      )}
    </>
  );
}

function Confirmation({ v }: { v: View }) {
  const p = v.payment;
  return (
    <div className="py-4">
      <div className="mb-4 text-center">
        <CheckCircle2 className="mx-auto mb-2 h-14 w-14 text-green-500" />
        <h2 className="text-xl font-bold text-[#015E65]">Payment received</h2>
        <p className="mt-1 text-sm text-gray-600">We have received the full fee. Your NOC will be issued and emailed to you shortly.</p>
      </div>
      <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1.5 rounded-lg border p-4 text-sm">
        <dt className="text-gray-500">Paid for</dt><dd>NOC · {v.purposeLabel} · {v.centre}</dd>
        <dt className="text-gray-500">Company</dt><dd>{v.company}</dd>
        <dt className="text-gray-500">Amount</dt><dd>{inr(v.fee.total)} ({inr(v.fee.excl)} + {inr(v.fee.tax)} GST)</dd>
        {p && <><dt className="text-gray-500">Date</dt><dd>{new Date(p.paidAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</dd></>}
        {p?.reference && <><dt className="text-gray-500">Payment reference</dt><dd className="break-all">{p.reference}</dd></>}
        {p?.invoiceNumber && <><dt className="text-gray-500">Invoice</dt><dd>{p.invoiceNumber}</dd></>}
        <dt className="text-gray-500">Valid till</dt><dd>{v.validUntilLabel}</dd>
        {v.acceptedBy && <><dt className="text-gray-500">Terms accepted by</dt><dd>{v.acceptedBy}</dd></>}
      </dl>
      <p className="mt-3 text-center text-xs text-gray-500">A receipt and your acceptance certificate have been emailed to you. Our accounts team will send the GST invoice.</p>
    </div>
  );
}

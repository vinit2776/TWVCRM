"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BadgeIndianRupee, Copy, FileText, Loader2, Lock, Mail, MessageCircle, Plus, RefreshCw, ShieldCheck, Stamp } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ReportPaymentDialog } from "@/components/queries/report-payment-dialog";
import { formatCurrency, formatDate } from "@/lib/utils";
import {
  canOrderNoc, canVoidNoc, isVoidable, issueBlocker, nocMarkers, NOC_STATUS_COLORS, NOC_STATUS_LABELS, PURPOSE_LABELS,
  validateOrder, type NocBrief, type NocMarker, type NocPurpose, type NocStatus,
} from "@/lib/noc/rules";

interface NocRow {
  id: string;
  noc_number: string;
  reference: string;
  sequence_in_contract: number;
  purpose: NocPurpose;
  status: NocStatus;
  company_name: string;
  cin: string | null;
  noc_address: string;
  fee_excl_gst: number;
  tax_percentage: number;
  gstin: string | null;
  invoice_id: string | null;
  billing_statement_id: string | null;
  sent_at: string | null;
  sent_to: string | null;
  accepted_at: string | null;
  accepted_by_name: string | null;
  razorpay_link_url: string | null;
  paid_at: string | null;
  payment_reference: string | null;
  void_reason: string | null;
  created_at: string;
  location: { id: string; name: string } | null;
}
interface Fee { excludingGst: number; tax: number; total: number }
interface NocData {
  enabled: boolean;
  contract?: { id: string; contract_number: string; status: string; end_date: string; location_id: string | null; orderable: boolean };
  suggestedCompany?: string;
  nocs?: NocRow[];
  centres?: { id: string; name: string; hasNocAddress: boolean; hasAddress: boolean }[];
  fees?: { roc: Fee; gst: Fee; taxPercentage: number };
}
interface AuditEvent { id: string; event: string; actor_label: string | null; detail: Record<string, unknown>; created_at: string }

// The compact sidebar card and the full panel in the main column are separate components on the contract page.
// They (and the header badges) talk through these window events, so none has to know where the others sit.
const EV_ORDER = "noc:order";
const EV_OPEN = "noc:open";
const EV_CHANGED = "noc:changed";
const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));

const todayYmd = () => new Date().toISOString().slice(0, 10);

function useNoc(contractId: string) {
  const [data, setData] = useState<NocData | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/contracts/${contractId}/noc`);
      if (res.ok) setData((await res.json()).data);
    } finally { setLoading(false); }
  }, [contractId]);
  useEffect(() => {
    load();
    window.addEventListener(EV_CHANGED, load);
    return () => window.removeEventListener(EV_CHANGED, load);
  }, [load]);
  return { data, loading, reload: load };
}

const TONE: Record<NocMarker["tone"], string> = {
  issued: "bg-teal-50 text-teal-800 border-teal-300",
  pending: "bg-amber-50 text-amber-800 border-amber-200",
  expired: "bg-slate-100 text-slate-600 border-slate-300",
};

/** The marker(s) next to the contract number: always visible once a NOC is issued, even if issued after the start. */
export function NocHeaderBadges({ contractId }: { contractId: string }) {
  const { data } = useNoc(contractId);
  if (!data?.enabled || !data.contract) return null;
  const briefs: NocBrief[] = (data.nocs ?? []).map((n) => ({ status: n.status, purpose: n.purpose, locationName: n.location?.name }));
  const markers = nocMarkers(briefs, data.contract.end_date, todayYmd());
  if (markers.length === 0) return null;
  return (
    <>
      {markers.map((m, i) => (
        <Badge key={i} variant="outline" className={TONE[m.tone]} title="NOC service">
          <ShieldCheck className="mr-1 h-3 w-3" />{m.text}
        </Badge>
      ))}
    </>
  );
}

/** Light per-contract summary for the contracts list (one request for the whole page of rows). */
export function useNocMarkers(contractIds: string[]) {
  const [map, setMap] = useState<Record<string, NocBrief[]>>({});
  const key = contractIds.join(",");
  useEffect(() => {
    if (!key) { setMap({}); return; }
    let cancelled = false;
    fetch(`/api/noc/markers?contract_ids=${key}`)
      .then((r) => (r.ok ? r.json() : { data: {} }))
      .then((j) => { if (!cancelled) setMap(j.data ?? {}); })
      .catch(() => { if (!cancelled) setMap({}); });
    return () => { cancelled = true; };
  }, [key]);
  return map;
}

export function NocListChip({ nocs, endDate }: { nocs: NocBrief[] | undefined; endDate: string | null | undefined }) {
  if (!nocs || nocs.length === 0) return null;
  const markers = nocMarkers(nocs, endDate, todayYmd());
  if (markers.length === 0) return null;
  return (
    <>
      {markers.map((m, i) => (
        <span key={i} title={m.text} className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${TONE[m.tone]}`}>NOC</span>
      ))}
    </>
  );
}

/** Compact card for the sidebar, next to Signed Contract: the Order button and a line per NOC. */
export function NocSidebarCard({ contractId, userRole }: { contractId: string; userRole: string | null }) {
  const { data, loading } = useNoc(contractId);
  if (loading || !data?.enabled) return null;
  const nocs = (data.nocs ?? []).filter((n) => n.status !== "void");
  const canOrder = canOrderNoc(userRole) && !!data.contract?.orderable;
  if (nocs.length === 0 && !canOrder) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><ShieldCheck className="h-4 w-4" />NOC service</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {nocs.length === 0 && (
          <p className="text-muted-foreground text-xs">A paid No Objection Certificate to register the customer&apos;s company at a centre, for ROC or GST.</p>
        )}
        {nocs.map((n) => (
          <button key={n.id} className="hover:bg-muted flex w-full items-start justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-sm" onClick={() => emit(EV_OPEN, n.id)}>
            <span>
              <span className="font-medium">{PURPOSE_LABELS[n.purpose]}</span>
              <span className="text-muted-foreground block text-xs">{n.location?.name} · {n.reference.split("/")[1]}</span>
            </span>
            <Badge variant="secondary" className={`shrink-0 ${NOC_STATUS_COLORS[n.status]}`}>{NOC_STATUS_LABELS[n.status]}</Badge>
          </button>
        ))}
        {canOrder && <Button size="sm" variant="outline" className="w-full" onClick={() => emit(EV_ORDER)}><Plus className="mr-1 h-4 w-4" />Order NOC</Button>}
        <p className="text-muted-foreground text-[11px]">₹20,000 + GST each for ROC and GST. Valid till the contract ends, and not carried into a renewal.</p>
      </CardContent>
    </Card>
  );
}

/** The panel in the main column: the opened NOC with its draft, order details and audit trail. Also owns the order dialog. */
export function NocPanel({ contractId, userRole }: { contractId: string; userRole: string | null }) {
  const { data, loading, reload } = useNoc(contractId);
  const [ordering, setOrdering] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    const onOrder = () => setOrdering(true);
    const onOpen = (e: Event) => {
      setOpenId((e as CustomEvent<string>).detail);
      setTimeout(() => document.getElementById("noc-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    };
    window.addEventListener(EV_ORDER, onOrder);
    window.addEventListener(EV_OPEN, onOpen);
    return () => { window.removeEventListener(EV_ORDER, onOrder); window.removeEventListener(EV_OPEN, onOpen); };
  }, []);

  if (loading || !data?.enabled) return null;
  const opened = (data.nocs ?? []).find((n) => n.id === openId) ?? null;
  const dialog = ordering && (
    <OrderDialog
      contractId={contractId} data={data} onClose={() => setOrdering(false)}
      onCreated={(id) => { setOrdering(false); reload(); emit(EV_CHANGED); setOpenId(id); setTimeout(() => emit(EV_OPEN, id), 120); }}
    />
  );
  if (!opened) return <>{dialog}</>;
  return (
    <>
      <Card id="noc-panel" className="scroll-mt-4">
        <CardHeader className="flex flex-row flex-wrap items-center gap-3">
          <CardTitle className="text-base">NOC · {PURPOSE_LABELS[opened.purpose]} · {opened.location?.name}</CardTitle>
          <Badge variant="secondary" className={NOC_STATUS_COLORS[opened.status]}>{NOC_STATUS_LABELS[opened.status]}</Badge>
          <span className="text-muted-foreground ml-auto font-mono text-xs">{opened.noc_number} · {opened.reference}</span>
        </CardHeader>
        <CardContent>
          <NocDetail contractId={contractId} noc={opened} data={data} userRole={userRole} onChanged={() => { reload(); emit(EV_CHANGED); }} onClose={() => setOpenId(null)} />
        </CardContent>
      </Card>
      {dialog}
    </>
  );
}

interface DetailData { events: AuditEvent[]; invoice: { invoice_number: string; status: string; total_amount: number; due_date: string | null } | null; customerLink: string | null }

const BANNER: Record<NocStatus, { tone: string; text: string }> = {
  draft: { tone: "border-amber-200 bg-amber-50 text-amber-800", text: "Not sent yet. Email the customer the proforma and link, or copy the link to send it by hand. The watermark stays and stamp and seal stay locked until the fee is paid in full." },
  sent: { tone: "border-amber-200 bg-amber-50 text-amber-800", text: "With the customer. Waiting for them to read and accept the terms on the link, then pay." },
  accepted: { tone: "border-amber-200 bg-amber-50 text-amber-800", text: "The customer has accepted the terms. Waiting for the payment." },
  paid: { tone: "border-indigo-200 bg-indigo-50 text-indigo-800", text: "Paid in full. Stamp, seal and issue unlocks for an admin in the next release." },
  issued: { tone: "border-green-200 bg-green-50 text-green-800", text: "Issued." },
  void: { tone: "border-slate-200 bg-slate-50 text-slate-600", text: "Void." },
};

function NocDetail({ contractId, noc, data, userRole, onChanged, onClose }: {
  contractId: string; noc: NocRow; data: NocData; userRole: string | null; onChanged: () => void; onClose: () => void;
}) {
  const base = `/api/contracts/${contractId}/noc/${noc.id}`;
  const [detail, setDetail] = useState<DetailData>({ events: [], invoice: null, customerLink: null });
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sendOpen, setSendOpen] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const fee = useMemo(() => {
    const tax = Math.round(noc.fee_excl_gst * noc.tax_percentage) / 100;
    return { excl: noc.fee_excl_gst, tax, total: Math.round((noc.fee_excl_gst + tax) * 100) / 100 };
  }, [noc]);

  // Held in refs so a new callback or a status change does not re-run the fetch (which would loop).
  const onChangedRef = useRef(onChanged);
  const statusRef = useRef(noc.status);
  useEffect(() => { onChangedRef.current = onChanged; statusRef.current = noc.status; });
  const reload = useCallback(async () => {
    const r = await fetch(base);
    if (r.ok) {
      const j = (await r.json()).data;
      setDetail({ events: j.events ?? [], invoice: j.invoice ?? null, customerLink: j.customerLink ?? null });
      // The server may have caught a payment up (see reconcileNocPaid): refresh the list behind this panel.
      if (j.noc.status !== statusRef.current) onChangedRef.current();
    }
  }, [base]);
  useEffect(() => { reload(); }, [reload, noc.status, noc.invoice_id, noc.razorpay_link_url]);

  const canSend = canOrderNoc(userRole) && (noc.status === "draft" || noc.status === "sent");
  const canTrackPayment = canOrderNoc(userRole) && ["draft", "sent", "accepted"].includes(noc.status);

  /** Makes sure the proforma and the link exist (idempotent), then returns the customer link. */
  async function prepare(): Promise<string | null> {
    const res = await fetch(`${base}/prepare`, { method: "POST" });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { toast.error(j.error ?? "Could not prepare the link."); return null; }
    onChanged(); reload();
    return j.data.link as string;
  }
  async function shareLink(channel: "copy" | "whatsapp") {
    setBusy(channel);
    try {
      const link = detail.customerLink ?? (await prepare());
      if (!link) return;
      if (channel === "copy") { await navigator.clipboard.writeText(link); toast.success("Customer link copied"); }
      else window.open(`https://wa.me/?text=${encodeURIComponent(`Please review the terms and pay for the NOC for ${noc.company_name}: ${link}`)}`, "_blank", "noopener");
      await fetch(`${base}/shared`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel }) });
      reload();
    } finally { setBusy(null); }
  }
  async function retryGatewayLink() {
    setBusy("gateway");
    try {
      const res = await fetch(`${base}/payment-link`, { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(j.error ?? "Could not create the payment link.");
      toast.success("Payment link created"); onChanged(); reload();
    } finally { setBusy(null); }
  }
  async function voidIt() {
    setBusy("void");
    try {
      const res = await fetch(base, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "void", reason }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(j.error ?? "That did not work. Try again.");
      toast.success("NOC order voided");
      setConfirming(false); setReason(""); onChanged(); onClose();
    } finally { setBusy(null); }
  }

  const steps = ["Ordered", "Emailed or shared", "Accepted terms", "Paid in full", "Stamped, sealed, issued"];
  const doneUpTo = { draft: 0, sent: 1, accepted: 2, paid: 3, issued: 4, void: -1 }[noc.status];
  const banner = BANNER[noc.status];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5">
        {steps.map((st, i) => (
          <span key={st} className={`rounded-full border px-2.5 py-0.5 text-xs ${i <= doneUpTo ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "text-muted-foreground bg-white"}`}>{st}</span>
        ))}
      </div>
      <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${banner.tone}`}>
        <Lock className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{noc.status === "void" && noc.void_reason ? `Void. ${noc.void_reason}` : banner.text}{noc.status === "paid" && !noc.accepted_at ? " Note: the customer has not accepted the terms on the link yet, and must before the NOC is issued." : ""}</span>
      </div>

      {(canSend || canTrackPayment) && (
        <div className="rounded-lg border">
          <div className="border-b bg-muted/40 px-3 py-2 text-sm font-medium">Send to the customer</div>
          <div className="space-y-3 p-3">
            <div className="flex flex-wrap gap-2">
              {canSend && <Button size="sm" onClick={() => setSendOpen(true)}><Mail className="mr-1 h-4 w-4" />Email PI and payment link</Button>}
              {canSend && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => shareLink("copy")}>{busy === "copy" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Copy className="mr-1 h-4 w-4" />}Copy customer link</Button>}
              {canSend && <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => shareLink("whatsapp")}><MessageCircle className="mr-1 h-4 w-4" />Share on WhatsApp</Button>}
              {canTrackPayment && noc.billing_statement_id && (
                <Button size="sm" variant="outline" className="border-teal-200 text-teal-700 hover:bg-teal-50" onClick={() => setReportOpen(true)} title="The customer says they paid outside the CRM: accounts will check the bank and record it">
                  <BadgeIndianRupee className="mr-1 h-4 w-4" />Report payment received
                </Button>
              )}
              {noc.status === "accepted" && !noc.razorpay_link_url && canOrderNoc(userRole) && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={retryGatewayLink}>{busy === "gateway" ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-1 h-4 w-4" />}Create payment link</Button>
              )}
            </div>
            {detail.customerLink ? (
              <div className="space-y-1 text-[13px]">
                <p className="text-muted-foreground text-xs">Customer link (opens our page, where the terms are accepted before payment). Use it to send by hand:</p>
                <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-2 py-1.5"><span className="min-w-0 flex-1 break-all font-mono text-xs">{detail.customerLink}</span></div>
                {noc.razorpay_link_url && <p className="text-muted-foreground break-all text-xs">Payment link made after acceptance (for reference): <span className="font-mono">{noc.razorpay_link_url}</span></p>}
              </div>
            ) : (
              <p className="text-muted-foreground text-xs">The proforma invoice and the customer link are created the first time you email or copy the link. Nothing is sent until you do.</p>
            )}
            {noc.status === "accepted" && !noc.razorpay_link_url && <p className="flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />No payment link yet. If online payment is switched off here, or the gateway failed, use Create payment link once it is available. The customer can also pay by bank transfer: use Report payment received.</p>}
          </div>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
        <div>
          <p className="mb-1 text-sm font-medium">Draft certificate (staff only, never sent)</p>
          <iframe key={noc.id} title="NOC draft" src={`${base}/pdf#toolbar=0`} className="h-[560px] w-full rounded-md border" />
          <a className="text-primary mt-1 inline-flex items-center gap-1 text-sm underline" href={`${base}/pdf`} target="_blank" rel="noreferrer"><FileText className="h-3.5 w-3.5" />Open / print draft PDF</a>
        </div>
        <div className="space-y-3 text-sm">
          <div className="rounded-lg border">
            <div className="border-b bg-muted/40 px-3 py-2 font-medium">Order</div>
            <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 p-3 text-[13px]">
              <dt className="text-muted-foreground">Company</dt><dd>{noc.company_name}</dd>
              {noc.cin && (<><dt className="text-muted-foreground">CIN</dt><dd>{noc.cin}</dd></>)}
              {noc.gstin && (<><dt className="text-muted-foreground">GSTIN</dt><dd>{noc.gstin}</dd></>)}
              <dt className="text-muted-foreground">Centre</dt><dd>{noc.location?.name}</dd>
              <dt className="text-muted-foreground">Address</dt><dd>{noc.noc_address}</dd>
              <dt className="text-muted-foreground">Fee</dt><dd>{formatCurrency(fee.total)} <span className="text-muted-foreground text-xs">({formatCurrency(fee.excl)} + {noc.tax_percentage}% GST)</span></dd>
              <dt className="text-muted-foreground">Invoice</dt><dd>{detail.invoice ? <>{detail.invoice.invoice_number} <span className="text-muted-foreground text-xs">({detail.invoice.status})</span></> : "not created yet"}</dd>
              <dt className="text-muted-foreground">Valid till</dt><dd>{data.contract ? formatDate(data.contract.end_date) : "—"} <span className="text-muted-foreground text-xs">(the contract&apos;s end date)</span></dd>
              {noc.sent_to && (<><dt className="text-muted-foreground">Sent to</dt><dd>{noc.sent_to}</dd></>)}
              {noc.accepted_by_name && (<><dt className="text-muted-foreground">Accepted by</dt><dd>{noc.accepted_by_name} <a className="text-primary text-xs underline" href={`${base}/acceptance`} target="_blank" rel="noreferrer">Acceptance certificate (PDF)</a></dd></>)}
              {noc.paid_at && (<><dt className="text-muted-foreground">Paid</dt><dd>{formatDate(noc.paid_at)}{noc.payment_reference ? ` · ${noc.payment_reference}` : ""}</dd></>)}
            </dl>
          </div>
          <div className="rounded-lg border">
            <div className="border-b bg-muted/40 px-3 py-2 font-medium">Tracking and audit trail</div>
            <ul className="space-y-1.5 p-3 text-[13px]">
              {detail.events.length === 0 && <li className="text-muted-foreground">No entries yet.</li>}
              {detail.events.map((e) => (
                <li key={e.id}>
                  <span className="font-medium">{EVENT_LABELS[e.event] ?? e.event}</span>
                  <span className="text-muted-foreground block text-xs">{new Date(e.created_at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}{e.actor_label ? ` · ${e.actor_label}` : ""}{eventNote(e)}</span>
                </li>
              ))}
            </ul>
            <p className="text-muted-foreground border-t px-3 py-1.5 text-[11px]">Written once and never changed.</p>
          </div>
        </div>
      </div>

      {noc.status !== "void" && noc.status !== "issued" && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border bg-muted/30 px-3 py-2">
          <Button size="sm" disabled title={issueBlocker(userRole, noc.status, noc.status === "paid") ?? ""}><Stamp className="mr-1 h-4 w-4" />Stamp, seal and issue</Button>
          <span className="text-muted-foreground text-xs">{noc.status === "paid" ? "Paid. Arrives in the next release for an admin." : issueBlocker(userRole, noc.status, false)} Admin only, using the same company stamp and seal as contracts and Virtual Office.</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        {canVoidNoc(userRole) && isVoidable(noc.status) && (
          confirming ? (
            <div className="flex flex-1 flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              <span>Void this order? It cannot be restarted; you would order again.</span>
              <Textarea className="min-h-[36px] w-full basis-full bg-white" rows={1} placeholder="Why (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
              <Button size="sm" variant="destructive" disabled={busy !== null || reason.trim().length < 5} onClick={voidIt}>Yes, void</Button>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => setConfirming(false)}>Keep it</Button>
            </div>
          ) : (
            <button className="text-muted-foreground text-sm underline" onClick={() => setConfirming(true)}>Void order</button>
          )
        )}
      </div>

      {sendOpen && <SendDialog base={base} noc={noc} onClose={() => setSendOpen(false)} onSent={() => { setSendOpen(false); onChanged(); reload(); }} />}
      {noc.billing_statement_id && (
        <ReportPaymentDialog
          open={reportOpen} onOpenChange={setReportOpen} entityType="billing_statement" entityId={noc.billing_statement_id}
          partyLabel={`${noc.company_name} · NOC ${noc.reference}`} suggestedAmount={fee.total} onReported={() => { onChanged(); reload(); }}
        />
      )}
    </div>
  );
}

/** Previews the email (sends nothing), then sends it when staff confirm. */
function SendDialog({ base, noc, onClose, onSent }: { base: string; noc: NocRow; onClose: () => void; onSent: () => void }) {
  const [to, setTo] = useState(noc.sent_to ?? "");
  const [preview, setPreview] = useState<{ to: string; subject: string; html: string; attachment: string | null; blockedReason: string | null; piProblem: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async (address?: string) => {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`${base}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ preview: true, ...(address ? { to: address } : {}) }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void setErr(j.error ?? "Could not build the email.");
      setPreview(j.data); setTo(j.data.to);
    } finally { setBusy(false); }
  }, [base]);
  useEffect(() => { load(); }, [load]);

  async function send() {
    setBusy(true); setErr("");
    try {
      const res = await fetch(`${base}/send`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ to }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void setErr(j.error ?? "The email was not sent.");
      toast.success(`Sent to ${to}`); onSent();
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Email the proforma and payment link</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label>To</Label>
            <div className="flex gap-2">
              <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="customer@company.com" />
              <Button variant="outline" size="sm" disabled={busy || !to.includes("@")} onClick={() => load(to)}>Update preview</Button>
            </div>
          </div>
          {preview ? (
            <>
              <p className="text-sm"><b>Subject:</b> {preview.subject}</p>
              <p className="text-muted-foreground text-xs">Attached: {preview.attachment ?? "no proforma (see below)"}</p>
              {preview.piProblem && <p className="text-xs text-red-700">The proforma invoice could not be prepared: {preview.piProblem}</p>}
              <div className="max-h-[320px] overflow-y-auto rounded-md border bg-white p-3" dangerouslySetInnerHTML={{ __html: preview.html }} />
              {preview.blockedReason && <p className="flex items-start gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{preview.blockedReason}</p>}
            </>
          ) : <Loader2 className="h-5 w-5 animate-spin" />}
          {err && <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{err}</p>}
          <p className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">This preview sends nothing. The proforma invoice is created now (once) and joins Receivables with the usual reminders.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={send} disabled={busy || !preview || !!preview.blockedReason || !!preview.piProblem || !to.includes("@")}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Send email</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const eventNote = (e: AuditEvent): string => {
  const d = e.detail as Record<string, unknown>;
  if (e.event === "emailed" || e.event === "email_failed" || e.event === "receipt_emailed") return d.to ? ` · ${String(d.to)}` : "";
  if (e.event === "code_sent" || e.event === "code_verified") return d.to ? ` · ${String(d.to)}` : d.sent_to ? ` · ${String(d.sent_to)}` : "";
  if (e.event === "clauses_accepted") {
    const m = { matches: "name matches the agreement's signatory", partial: "name partly matches the signatory", mismatch: "name does NOT match the signatory (review before issuing)", no_record: "no signatory recorded on the agreement to compare" }[String(d.signatory_match ?? "")];
    return m ? ` · ${m}` : "";
  }
  if (e.event === "payment_received") return ` · ${d.reference ? String(d.reference) : "recorded"}`;
  if (e.event === "invoice_created") return d.invoice_number ? ` · ${String(d.invoice_number)}` : "";
  if (e.event === "link_shared") return d.channel ? ` · ${String(d.channel)}` : "";
  return "";
};

const EVENT_LABELS: Record<string, string> = {
  order_created: "Order created",
  invoice_created: "Proforma invoice created",
  emailed: "Emailed to the customer with the proforma",
  email_failed: "Email not sent",
  link_shared: "Customer link shared by hand",
  link_opened: "Customer opened the link",
  code_sent: "One-time code emailed to the customer",
  code_send_failed: "Code could not be sent",
  code_rejected: "A wrong or expired code was entered",
  code_verified: "One-time code verified",
  clauses_accepted: "Terms accepted by the customer",
  acceptance_certificate_made: "Acceptance certificate made",
  acceptance_certificate_failed: "Acceptance certificate could not be made",
  payment_link_created: "Payment link created",
  payment_link_failed: "Payment link could not be created",
  payment_received: "Payment received in full",
  paid_without_acceptance: "Paid before the terms were accepted",
  receipt_emailed: "Receipt and acceptance certificate emailed",
  receipt_not_sent: "Receipt could not be emailed",
  receipt_skipped: "Receipt not emailed",
  voided: "Order voided",
};

function OrderDialog({ contractId, data, onClose, onCreated }: { contractId: string; data: NocData; onClose: () => void; onCreated: (id: string) => void }) {
  const [purpose, setPurpose] = useState<NocPurpose | "">("");
  const [locationId, setLocationId] = useState("");
  const [companyName, setCompanyName] = useState(data.suggestedCompany ?? "");
  const [cin, setCin] = useState("");
  const [gstin, setGstin] = useState("");
  const [busy, setBusy] = useState(false);
  const centre = data.centres?.find((c) => c.id === locationId);
  const fee = purpose && data.fees ? data.fees[purpose] : null;
  const problems = validateOrder({ purpose, locationId, companyName, cin, gstin });

  async function create() {
    setBusy(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/noc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose, locationId, companyName, cin, gstin }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(j.error ?? "Could not create the order");
      toast.success("NOC order created as a draft. Nothing has been sent.");
      onCreated(j.data.id);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Order a NOC for registration</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>What is it for?</Label>
            {(["roc", "gst"] as NocPurpose[]).map((p) => (
              <label key={p} className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 text-sm">
                <input type="radio" className="mt-1" checked={purpose === p} onChange={() => setPurpose(p)} />
                <span>
                  <b>{PURPOSE_LABELS[p]}</b>
                  <span className="text-muted-foreground block text-xs">
                    {p === "roc" ? "Company incorporation or change of registered office." : "Principal place of business for GST."}
                    {data.fees && <> {formatCurrency(data.fees[p].excludingGst)} + GST</>}
                  </span>
                </span>
              </label>
            ))}
            <p className="text-muted-foreground text-xs">A certificate covers one purpose only. If the customer needs both, order twice.</p>
          </div>
          <div className="space-y-1">
            <Label>Which centre?</Label>
            <select className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm" value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">Choose an active centre</option>
              {data.centres?.map((c) => <option key={c.id} value={c.id}>{c.name}{c.id === data.contract?.location_id ? " (this agreement's centre)" : ""}</option>)}
            </select>
            <p className="text-muted-foreground text-xs">Any active centre, whatever centre the agreement is at.</p>
            {centre && !centre.hasNocAddress && (
              <p className="flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{centre.name} has no NOC address set, so its normal address will be printed. To print it another way, set the NOC address under Locations first.{!centre.hasAddress && " It has no normal address either: add one under Locations before ordering."}</p>
            )}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1"><Label>Company name</Label><Input value={companyName} onChange={(e) => setCompanyName(e.target.value)} /></div>
            <div className="space-y-1"><Label>CIN (if incorporated)</Label><Input value={cin} onChange={(e) => setCin(e.target.value)} placeholder="optional" /></div>
            <div className="space-y-1 sm:col-span-2"><Label>Company GSTIN (for the GST invoice)</Label><Input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="optional, accounts raise the GST invoice to this" /></div>
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-sm">
            {fee ? (
              <div className="space-y-0.5">
                <div className="flex justify-between"><span>NOC fee</span><span>{formatCurrency(fee.excludingGst)}</span></div>
                <div className="flex justify-between"><span>GST {data.fees?.taxPercentage}%</span><span>{formatCurrency(fee.tax)}</span></div>
                <div className="flex justify-between font-semibold"><span>Total</span><span>{formatCurrency(fee.total)}</span></div>
              </div>
            ) : <span className="text-muted-foreground">Choose a purpose to see the fee.</span>}
            <p className="text-muted-foreground mt-2 text-xs">Valid till {data.contract ? formatDate(data.contract.end_date) : "the contract end"}. A renewal or a new contract needs a new, paid NOC. The fee is frozen on the order.</p>
          </div>
          <p className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-800">Creating the order makes a draft only. Nothing is sent to the customer and no money is taken.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={create} disabled={busy || problems.length > 0 || (!!centre && !centre.hasNocAddress && !centre.hasAddress)}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Create draft order</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

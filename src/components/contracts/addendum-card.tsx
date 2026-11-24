"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Plus, FileText, CheckCircle2, AlertTriangle, Upload, Stamp, Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDate } from "@/lib/utils";
import { ENTITY_TYPE_LABELS } from "@/lib/constants";
import {
  ADDENDUM_STATUS_LABELS, checklistFor, KIND_LABELS, contextWarnings, canApproveAddendum, canAuthorAddendum, canSealAddendum,
  findPlaceholders, isEditable, longDate, careOfInText, CARE_OF_MESSAGE, isCompanyLike, CARE_OF_RE, type AddendumStatus, type ChangeOfNameKind,
} from "@/lib/addendum/change-of-name";

interface Addendum {
  id: string;
  addendum_number: number;
  status: AddendumStatus;
  current_text: string;
  reason: string;
  revision: number;
  decision_note: string | null;
  signed_document_id: string | null;
  sealed_document_id: string | null;
  params: { kind?: ChangeOfNameKind; newName: string; entityType?: string; effectiveDate: string; docsHeld?: string[] };
  created_by: string | null;
  created_by_user?: { full_name: string } | null;
  decided_by_user?: { full_name: string } | null;
  applied_at: string | null;
}
interface Detail { revisions: { revision: number; source: string; created_at: string }[]; applyPreview: { field: string; before: string | null; after: string | null }[] }

const BADGE: Record<AddendumStatus, string> = {
  draft: "bg-slate-100 text-slate-700 border-slate-200",
  pending_approval: "bg-amber-100 text-amber-800 border-amber-200",
  changes_requested: "bg-red-100 text-red-800 border-red-200",
  approved: "bg-indigo-100 text-indigo-800 border-indigo-200",
  signed: "bg-indigo-100 text-indigo-800 border-indigo-200",
  sealed: "bg-green-100 text-green-800 border-green-200",
  applied: "bg-green-100 text-green-800 border-green-200",
  withdrawn: "bg-slate-100 text-slate-500 border-slate-200",
};
const FIELD_LABEL: Record<string, string> = { company: "Company", gst_number: "GSTIN", pan_number: "PAN", entity_type: "Entity type" };

const bytesToBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fileToBase64 = async (f: File) => bytesToBase64(new Uint8Array(await f.arrayBuffer()));

interface LeadInfo { company: string | null; pan_number: string | null; entity_type: string | null; first_name: string; last_name: string }

interface Props { contractId: string; userRole: string | null; onChanged?: () => void }

// The compact card beside the Signed Contract card and the full panel in the main column are separate
// components on the page; they talk through these window events so neither has to know where the other sits.
const SIGNING_PLACEHOLDER = "[date of signing]";
const EV_CREATE = "addendum:create";
const EV_OPEN = "addendum:open";
const EV_CHANGED = "addendum:changed";
const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** Compact card for the sidebar, next to the signed contract: the Create button and a status line per addendum. */
export function AddendumSidebarCard({ contractId, userRole }: { contractId: string; userRole: string | null }) {
  const [addenda, setAddenda] = useState<Pick<Addendum, "id" | "addendum_number" | "status">[]>([]);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${contractId}/addenda`);
    if (res.ok) setAddenda((await res.json()).data.addenda ?? []);
    setLoading(false);
  }, [contractId]);
  useEffect(() => {
    load();
    window.addEventListener(EV_CHANGED, load);
    return () => window.removeEventListener(EV_CHANGED, load);
  }, [load]);

  const canAuthor = canAuthorAddendum(userRole);
  if (!loading && addenda.length === 0 && !canAuthor) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><FileText className="h-4 w-4" />Addenda</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading && <Loader2 className="h-4 w-4 animate-spin" />}
        {!loading && addenda.length === 0 && <p className="text-muted-foreground text-xs">Changes to the signed agreement, such as a change of name.</p>}
        {addenda.map((a) => (
          <button key={a.id} className="hover:bg-muted flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-sm" onClick={() => emit(EV_OPEN, a.id)}>
            <span className="font-medium">Addendum {a.addendum_number}</span>
            <Badge variant="secondary" className={BADGE[a.status]}>{ADDENDUM_STATUS_LABELS[a.status]}</Badge>
          </button>
        ))}
        {canAuthor && <Button size="sm" variant="outline" className="w-full" onClick={() => emit(EV_CREATE)}><Plus className="mr-1 h-4 w-4" />Create addendum</Button>}
      </CardContent>
    </Card>
  );
}

export function AddendumCard({ contractId, userRole, onChanged }: Props) {
  const base = `/api/contracts/${contractId}/addenda`;
  const [addenda, setAddenda] = useState<Addendum[]>([]);
  const [others, setOthers] = useState<{ contract_number: string }[]>([]);
  const [lead, setLead] = useState<LeadInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(base);
    if (res.ok) {
      const j = (await res.json()).data;
      setAddenda(j.addenda ?? []);
      setOthers(j.otherContracts ?? []);
      const l = j.contract?.lead;
      setLead((Array.isArray(l) ? l[0] : l) ?? null);
    }
    setLoading(false);
  }, [base]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onCreate = () => setCreating(true);
    const onOpen = (e: Event) => {
      setOpenId((e as CustomEvent<string>).detail);
      setTimeout(() => document.getElementById("addenda-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    };
    const onChangedEv = () => load();
    window.addEventListener(EV_CREATE, onCreate);
    window.addEventListener(EV_OPEN, onOpen);
    window.addEventListener(EV_CHANGED, onChangedEv);
    return () => {
      window.removeEventListener(EV_CREATE, onCreate);
      window.removeEventListener(EV_OPEN, onOpen);
      window.removeEventListener(EV_CHANGED, onChangedEv);
    };
  }, [load]);

  const refresh = () => { load(); emit(EV_CHANGED); onChanged?.(); };
  const dialog = creating && <CreateDialog base={base} lead={lead} onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); refresh(); setOpenId(id); }} />;
  // With nothing to show, the sidebar card (Create button) is the only entry point; this panel appears with the first addendum.
  if (loading || addenda.length === 0) return <>{dialog}</>;

  return (
    <Card id="addenda-panel" className="scroll-mt-4">
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="text-base">Addenda</CardTitle>
        <p className="text-muted-foreground flex-1 text-sm">Written changes to this agreement, signed by the customer and sealed by TWV.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {addenda.map((a) => (
          <div key={a.id} className="rounded-lg border">
            <button className="flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left" onClick={() => setOpenId(openId === a.id ? null : a.id)}>
              <FileText className="text-muted-foreground h-4 w-4" />
              <span className="font-medium">Addendum {a.addendum_number} · Change of name{a.params.kind === "same_entity" ? " (renamed)" : " (new party)"}</span>
              <Badge variant="secondary" className={BADGE[a.status]}>{ADDENDUM_STATUS_LABELS[a.status]}</Badge>
              <span className="text-muted-foreground ml-auto text-xs">to {a.params.newName} from {formatDate(a.params.effectiveDate)}</span>
            </button>
            {openId === a.id && <AddendumPanel base={base} a={a} userRole={userRole} others={others} onChanged={refresh} />}
          </div>
        ))}
      </CardContent>
      {dialog}
    </Card>
  );
}

function CreateDialog({ base, lead, onClose, onCreated }: { base: string; lead: LeadInfo | null; onClose: () => void; onCreated: (id: string) => void }) {
  const nextMonth = useMemo(() => { const d = new Date(); d.setMonth(d.getMonth() + 1, 1); return d.toISOString().slice(0, 10); }, []);
  const [kind, setKind] = useState<ChangeOfNameKind | null>(null);
  const [f, setF] = useState({
    newName: "", entityType: "pvt_ltd", gstin: "", pan: "", cin: "", registeredAddress: "", signatoryName: "", signatoryDesignation: "",
    effectiveDate: nextMonth, depositCarriesOver: true, companyTakesEarlierDues: false, outgoingAddress: "",
    outgoingIsEntity: false, outgoingSignatoryName: "", outgoingSignatoryDesignation: "",
  });
  const [reason, setReason] = useState("");
  const [docs, setDocs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const checklist = kind ? checklistFor(kind, f.outgoingIsEntity) : [];
  const missing = checklist.filter((d) => !docs.includes(d));
  const same = kind === "same_entity";
  const careOfBadForm = isCompanyLike(same ? (lead?.entity_type || "other") : f.entityType, f.newName) && CARE_OF_RE.test(f.registeredAddress);
  const warnings = kind ? contextWarnings(kind, f.pan, lead?.pan_number, f.entityType, lead?.entity_type) : [];
  const currentName = lead?.company?.trim() || `${lead?.first_name ?? ""} ${lead?.last_name ?? ""}`.trim();

  async function create() {
    setBusy(true);
    try {
      const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purpose: "change_of_name", reason, params: { ...f, kind, entityType: same ? (lead?.entity_type || "other") : f.entityType, docsHeld: docs } }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(j.error ?? "Could not create the addendum");
      toast.success("Draft ready. Review and edit the wording.");
      onCreated(j.data.id);
    } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Create addendum: change of name</DialogTitle></DialogHeader>
        <div className="space-y-2 rounded-lg border bg-slate-50 p-3">
          <p className="text-sm font-medium">What kind of change of name is this?</p>
          {currentName && <p className="text-muted-foreground text-xs">The agreement is currently in the name of <b>{currentName}</b>.</p>}
          {(Object.keys(KIND_LABELS) as ChangeOfNameKind[]).map((k) => (
            <label key={k} className="flex items-start gap-2 text-sm">
              <input type="radio" name="kind" className="mt-1" checked={kind === k} onChange={() => setKind(k)} />
              <span>{KIND_LABELS[k]}{k === "new_entity" && <span className="text-muted-foreground block text-xs">The outgoing person signs too, and the company&apos;s papers are needed. The deposit and earlier dues are addressed in the wording.</span>}{k === "same_entity" && <span className="text-muted-foreground block text-xs">Nothing is assigned. Only the name changes, so a shorter addendum with two signatures.</span>}</span>
            </label>
          ))}
        </div>
        {kind && (<>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><Label>{same ? "New name" : "New legal name"}</Label><Input value={f.newName} onChange={set("newName")} /></div>
          {!same && (
            <div className="space-y-1"><Label>Entity type</Label>
              <select className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm" value={f.entityType} onChange={set("entityType")}>
                {Object.entries(ENTITY_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select></div>
          )}
          <div className="space-y-1"><Label>GSTIN</Label><Input value={f.gstin} onChange={set("gstin")} placeholder="optional" /></div>
          <div className="space-y-1"><Label>PAN{same ? " (if re-issued)" : ""}</Label><Input value={f.pan} onChange={set("pan")} placeholder="optional" /></div>
          <div className="space-y-1"><Label>CIN / registration no.</Label><Input value={f.cin} onChange={set("cin")} placeholder="optional" /></div>
          <div className="space-y-1"><Label>Effective from (first invoice in the new name)</Label><Input type="date" value={f.effectiveDate} onChange={set("effectiveDate")} /></div>
          <div className="space-y-1 sm:col-span-2"><Label>{same ? "Address" : "Registered address"}</Label><Input value={f.registeredAddress} onChange={set("registeredAddress")} />
            {careOfBadForm && <p className="flex items-start gap-1 text-xs text-red-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{CARE_OF_MESSAGE}</p>}</div>
          {!same && (<>
            <div className="space-y-1"><Label>Who is the outgoing party?</Label>
              <select className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm" value={String(f.outgoingIsEntity)} onChange={(e) => setF({ ...f, outgoingIsEntity: e.target.value === "true" })}>
                <option value="false">An individual (becoming a company, firm or other entity)</option><option value="true">An entity (another company or firm is taking over)</option></select></div>
            <div className="space-y-1"><Label>Outgoing party&apos;s address</Label><Input value={f.outgoingAddress} onChange={set("outgoingAddress")} /></div>
            {f.outgoingIsEntity && (<>
              <div className="space-y-1"><Label>Signs for the outgoing entity</Label><Input value={f.outgoingSignatoryName} onChange={set("outgoingSignatoryName")} /></div>
              <div className="space-y-1"><Label>Their designation</Label><Input value={f.outgoingSignatoryDesignation} onChange={set("outgoingSignatoryDesignation")} /></div>
            </>)}
          </>)}
          <div className="space-y-1"><Label>Authorised signatory</Label><Input value={f.signatoryName} onChange={set("signatoryName")} /></div>
          <div className="space-y-1"><Label>Designation</Label><Input value={f.signatoryDesignation} onChange={set("signatoryDesignation")} /></div>
          {!same && (<>
            <div className="space-y-1"><Label>Security deposit</Label>
              <select className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm" value={String(f.depositCarriesOver)} onChange={(e) => setF({ ...f, depositCarriesOver: e.target.value === "true" })}>
                <option value="true">Carries over, held for the new party</option><option value="false">Handled separately in writing</option></select></div>
            <div className="space-y-1"><Label>Dues before the effective date</Label>
              <select className="border-input h-9 w-full rounded-md border bg-transparent px-3 text-sm" value={String(f.companyTakesEarlierDues)} onChange={(e) => setF({ ...f, companyTakesEarlierDues: e.target.value === "true" })}>
                <option value="false">Stay with the outgoing person</option><option value="true">New party takes them over</option></select></div>
          </>)}
          <div className="space-y-1 sm:col-span-2"><Label>Why is this needed? (internal, never printed)</Label><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        </div>
        {warnings.map((w) => <p key={w} className="flex items-start gap-1 rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</p>)}
        <div className="rounded-lg border p-3">
          <p className="mb-1 text-sm font-medium">Papers received</p>
          {checklist.map((d) => (
            <label key={d} className="flex items-center gap-2 py-0.5 text-sm">
              <input type="checkbox" checked={docs.includes(d)} onChange={() => setDocs(docs.includes(d) ? docs.filter((x) => x !== d) : [...docs, d])} />{d}
            </label>
          ))}
          {missing.length > 0 && <p className="mt-2 flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5" />Not yet received: {missing.join("; ")}. This does not stop the draft. Upload them on the Documents card above.</p>}
        </div>
        </>)}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={create} disabled={busy || careOfBadForm || !kind || !f.newName || !f.signatoryName || (kind === "new_entity" && f.outgoingIsEntity && !f.outgoingSignatoryName) || reason.trim().length < 5}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Draft addendum</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddendumPanel({ base, a, userRole, others, onChanged }: { base: string; a: Addendum; userRole: string | null; others: { contract_number: string }[]; onChanged: () => void }) {
  const url = `${base}/${a.id}`;
  const [text, setText] = useState(a.current_text);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const [stamping, setStamping] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [pdfKey, setPdfKey] = useState(0);
  const dirty = text !== a.current_text;
  const open = findPlaceholders(text);
  const careOfBad = careOfInText(text, a.params);

  useEffect(() => { setText(a.current_text); }, [a.current_text]);
  useEffect(() => { fetch(url).then((r) => r.ok ? r.json() : null).then((j) => j && setDetail(j.data)); }, [url, a.status]);

  async function act(body: Record<string, unknown>, ok: string) {
    setBusy(true);
    try {
      const res = await fetch(url, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(j.error ?? "That did not work. Try again.");
      toast.success(ok); setSendingBack(false); setWithdrawing(false); setNote(""); setPdfKey((k) => k + 1); onChanged();
    } finally { setBusy(false); }
  }
  async function uploadSigned(file: File) {
    setBusy(true);
    try {
      const res = await fetch(`${url}/signed`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdfBase64: await fileToBase64(file) }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(j.error ?? "Upload failed");
      toast.success("Signed copy uploaded"); onChanged();
    } finally { setBusy(false); }
  }

  const editable = isEditable(a.status) && canAuthorAddendum(userRole);
  const status = a.status;
  const selfDraft = a.created_by_user && status === "pending_approval";

  return (
    <div className="space-y-3 border-t p-3">
      {a.decision_note && status === "changes_requested" && <div className="rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800">Sent back: {a.decision_note}</div>}
      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-2">
          <Label>Addendum wording{editable ? " (editable)" : " (locked)"}</Label>
          <Textarea className="min-h-[380px] font-serif text-sm leading-relaxed" value={text} readOnly={!editable} onChange={(e) => setText(e.target.value)} />
          {open.length > 0 && editable && <p className="flex items-start gap-1 text-xs text-amber-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5" />Fill in {open.join(", ")} before submitting.</p>}
          {editable && careOfBad && <p className="flex items-start gap-1 text-xs text-red-700"><AlertTriangle className="mt-0.5 h-3.5 w-3.5" />{CARE_OF_MESSAGE} Edit the new party&apos;s line above, then save.</p>}
          {editable && text.includes(SIGNING_PLACEHOLDER) && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor={`sign-date-${a.id}`} className="text-xs">Date of signing</Label>
              <Input id={`sign-date-${a.id}`} type="date" className="h-8 w-44" onChange={(e) => e.target.value && setText((t) => t.split(SIGNING_PLACEHOLDER).join(longDate(e.target.value)))} />
              <span className="text-muted-foreground text-xs">Fills it into the wording. Save changes, then submit.</span>
            </div>
          )}
          {editable && (
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" disabled={!dirty || busy} onClick={() => act({ action: "save", text }, "Saved as a new revision")}>Save changes</Button>
              <Button size="sm" disabled={busy || dirty || open.length > 0 || careOfBad} onClick={() => act({ action: "submit" }, "Submitted for approval")}>Submit for approval</Button>
              {dirty && <span className="text-muted-foreground self-center text-xs">Save before submitting.</span>}
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label>PDF preview</Label>
          <iframe key={pdfKey + a.revision + status} src={`${url}/pdf#toolbar=0`} className="h-[420px] w-full rounded-md border" title="Addendum PDF" />
          <a className="inline-flex items-center gap-1 text-sm underline" href={`${url}/pdf`} target="_blank" rel="noreferrer"><Download className="h-3.5 w-3.5" />Open / print PDF</a>
          {detail && <p className="text-muted-foreground text-xs">Revisions: {detail.revisions.map((r) => `#${r.revision}`).join(", ")} · {a.created_by_user?.full_name ? `started by ${a.created_by_user.full_name}` : ""}</p>}
        </div>
      </div>

      {status === "pending_approval" && (canApproveAddendum(userRole) ? (
        <div className="space-y-2 rounded-md border bg-slate-50 p-3">
          <p className="text-sm">Read the wording, then approve it or send it back. Approving locks the text.</p>
          {selfDraft && userRole !== "admin" && <p className="text-xs text-amber-700">Submitted by {a.created_by_user?.full_name}. Only another manager or an admin can approve it.</p>}
          {sendingBack && <Input placeholder="What should change?" value={note} onChange={(e) => setNote(e.target.value)} />}
          <div className="flex gap-2">
            <Button size="sm" disabled={busy} onClick={() => act({ action: "approve" }, "Approved. Print it for the customer to sign.")}>Approve</Button>
            {!sendingBack ? <Button size="sm" variant="outline" onClick={() => setSendingBack(true)}>Send back</Button>
              : <Button size="sm" variant="outline" disabled={busy || note.trim().length < 5} onClick={() => act({ action: "send_back", note }, "Sent back")}>Confirm send back</Button>}
          </div>
        </div>
      ) : <p className="text-sm text-amber-700">Waiting for a manager or admin to approve.</p>)}

      {status === "approved" && canAuthorAddendum(userRole) && (
        <div className="space-y-2 rounded-md border bg-indigo-50 p-3">
          <p className="text-sm">Print the PDF. The outgoing person and the company&apos;s signatory sign it (with the company stamp). Scan it and upload it here. TWV signs after this.</p>
          <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border bg-white px-3 py-1.5 text-sm">
            <Upload className="h-4 w-4" />Upload customer-signed PDF
            <input type="file" accept="application/pdf" className="hidden" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadSigned(f); e.target.value = ""; }} />
          </label>
        </div>
      )}

      {status === "signed" && (canSealAddendum(userRole)
        ? <div className="flex items-center gap-3 rounded-md border bg-indigo-50 p-3"><p className="flex-1 text-sm">The customer&apos;s signed copy is on file. Place TWV&apos;s signature and seal on it.</p><Button size="sm" onClick={() => setStamping(true)}><Stamp className="mr-1 h-4 w-4" />Stamp &amp; seal</Button></div>
        : <p className="text-sm text-amber-700">Waiting for an admin to stamp and seal.</p>)}

      {status === "sealed" && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3">
          <p className="text-sm font-medium text-amber-800">One step left: apply the name change to the customer record.</p>
          <p className="text-xs text-amber-800">A separate click on purpose, so invoices never change by accident. Invoices before {formatDate(a.params.effectiveDate)} keep the old name.</p>
          {detail && detail.applyPreview.length > 0 && (
            <table className="w-full text-sm"><thead><tr className="text-muted-foreground text-left text-xs"><th>Field</th><th>Now</th><th>After</th></tr></thead>
              <tbody>{detail.applyPreview.map((r) => <tr key={r.field}><td>{FIELD_LABEL[r.field] ?? r.field}</td><td>{r.before ?? "(blank)"}</td><td className="font-medium">{r.after}</td></tr>)}</tbody></table>
          )}
          {others.length > 0 && <p className="text-xs text-red-700">Also on this customer record: {others.map((o) => o.contract_number).join(", ")}. They will show the new name too.</p>}
          {canSealAddendum(userRole)
            ? <Button size="sm" disabled={busy} onClick={() => act({ action: "apply" }, "Applied. Future invoices use the new name.")}>Apply name change</Button>
            : <p className="text-xs">An admin applies this.</p>}
        </div>
      )}

      {status === "applied" && <p className="flex items-center gap-1 text-sm text-green-700"><CheckCircle2 className="h-4 w-4" />Applied{a.applied_at ? ` on ${formatDate(a.applied_at)}` : ""}. The signed copy is filed as a contract document.</p>}

      {["draft", "pending_approval", "changes_requested", "approved", "signed"].includes(status) && canAuthorAddendum(userRole) && (
        withdrawing ? (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-sm text-red-800">
            <span>Withdraw this addendum? It cannot be restarted; you would create a new one.</span>
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => act({ action: "withdraw" }, "Withdrawn")}>Yes, withdraw</Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setWithdrawing(false)}>Keep it</Button>
          </div>
        ) : (
          <button className="text-muted-foreground text-xs underline" disabled={busy} onClick={() => setWithdrawing(true)}>Withdraw addendum</button>
        )
      )}
      {stamping && a.signed_document_id && <StampDialog url={url} documentId={a.signed_document_id} onClose={() => setStamping(false)} onDone={() => { setStamping(false); onChanged(); }} />}
    </div>
  );
}

/** Click-to-place TWV signature and seal on the customer's signed scan (same approach as the agreement stamp). */
function StampDialog({ url, documentId, onClose, onDone }: { url: string; documentId: string; onClose: () => void; onDone: () => void }) {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [img, setImg] = useState<string | null>(null);
  const [click, setClick] = useState<{ x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const render = useCallback(async (src: Uint8Array, n: number) => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    const pdf = await pdfjs.getDocument({ data: src.slice() }).promise;
    const p = await pdf.getPage(n);
    const vp = p.getViewport({ scale: 1.4 });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width; canvas.height = vp.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is not supported in this browser");
    await p.render({ canvas, canvasContext: ctx, viewport: vp }).promise;
    setImg(canvas.toDataURL("image/png"));
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const v = await fetch(`/api/documents/${documentId}/view`);
        if (!v.ok) throw new Error("Could not open the signed copy");
        const file = await fetch((await v.json()).signedUrl);
        const b = new Uint8Array(await file.arrayBuffer());
        const { PDFDocument } = await import("pdf-lib");
        const n = (await PDFDocument.load(b)).getPageCount();
        setBytes(b); setPages(n); setPage(n);
        await render(b, n);
      } catch (e) { toast.error(e instanceof Error ? e.message : "Could not load the PDF"); onClose(); }
    })();
  }, [documentId, render, onClose]);

  async function changePage(n: number) {
    if (!bytes) return;
    const c = Math.min(Math.max(n, 1), pages);
    setPage(c); setClick(null); setImg(null); await render(bytes, c);
  }

  async function confirmStamp() {
    if (!bytes || !click) return;
    setBusy(true);
    try {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
      const { COMPANY_SIGNATURE_BASE64 } = await import("@/lib/signature-data");
      const { COMPANY_SEAL_BASE64 } = await import("@/lib/seal-data");
      const { generateStampReference } = await import("@/lib/company-stamp");
      const stampRef = generateStampReference();
      const toBytes = (u: string) => Uint8Array.from(atob(u.split(",")[1]), (c) => c.charCodeAt(0));
      const doc = await PDFDocument.load(bytes);
      const target = doc.getPages()[page - 1];
      const { width, height } = target.getSize();
      const sig = await doc.embedPng(toBytes(COMPANY_SIGNATURE_BASE64));
      const seal = await doc.embedPng(toBytes(COMPANY_SEAL_BASE64));
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const sealSize = 44, sigH = 26, gap = 6, m = 4;
      const sigW = sigH * (sig.width / sig.height);
      const cw = sigW + gap + sealSize, ch = Math.max(sigH, sealSize);
      const left = Math.min(Math.max(click.x * width - cw / 2, m), width - cw - m);
      const bottom = Math.min(Math.max(height - click.y * height - ch / 2, m + 12), height - ch - m);
      target.drawImage(sig, { x: left, y: bottom + (ch - sigH) / 2, width: sigW, height: sigH });
      target.drawImage(seal, { x: left + sigW + gap, y: bottom + (ch - sealSize) / 2, width: sealSize, height: sealSize });
      target.drawText(`TWV Ref: ${stampRef}`, { x: left, y: bottom - 9, size: 5.5, font, color: rgb(0.5, 0.5, 0.5) });
      const out = await doc.save();
      const res = await fetch(`${url}/signed`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pdfBase64: bytesToBase64(out), stampRef }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return void toast.error(j.error ?? "Could not save the stamped copy");
      toast.success("Stamped and sealed"); onDone();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Stamping failed"); } finally { setBusy(false); }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>Stamp &amp; seal the signed addendum</DialogTitle></DialogHeader>
        <p className="text-muted-foreground text-sm">Pick the page with the signature blocks, then click where TWV&apos;s signature and seal should sit. The customer&apos;s signatures stay as they are.</p>
        <div className="flex items-center gap-2 text-sm">Page <Input className="h-8 w-16" type="number" min={1} max={pages || 1} value={page} onChange={(e) => changePage(Number(e.target.value))} /> of {pages}</div>
        {!img ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          <div className="relative inline-block border">
            {/* eslint-disable-next-line @next/next/no-img-element -- a rendered PDF page, not a static asset */}
            <img src={img} alt="Signed addendum page" className="max-w-full cursor-crosshair" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setClick({ x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height }); }} />
            {click && <div className="pointer-events-none absolute h-9 w-24 -translate-x-1/2 -translate-y-1/2 rounded border-2 border-dashed border-teal-700 bg-teal-500/20" style={{ left: `${click.x * 100}%`, top: `${click.y * 100}%` }} />}
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!click || busy} onClick={confirmStamp}>{busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}Confirm &amp; save</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

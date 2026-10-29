"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, Loader2, UserPlus, Users, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { formatDate } from "@/lib/utils";
import { DEFAULT_ACCESS_ROLES, PERSON_ROLES, type AccessSetup, type PersonRole, type PersonSetup } from "@/lib/contract-people";
import { ContractAccessSetupWizard } from "./contract-access-setup-wizard";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Person {
  contactId: string;
  memberId: string | null;
  name: string;
  role: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  needsVoucher: boolean;
  needsDoor: boolean;
  voucherIssued: boolean;
  voucher: { seatNumber: number; validUntil: string | null } | null;
  doorEnrolled: boolean;
  doorStatuses: string[];
  leftOn: string | null;
  leftReason: string | null;
}

interface PeopleResponse {
  seats: number;
  contractStatus: string;
  people: Person[];
  setup: AccessSetup;
}

interface Props {
  contractId: string;
  contractStatus: string;
  signedDocumentId?: string | null;
  /** Called after anything changes so the parent can refresh sibling sections. */
  onChanged?: () => void;
}

interface DuplicateInfo {
  contactId: string;
  name: string;
  hasAccess: boolean;
}

const ROLE_LABELS: Record<string, string> = {
  occupant: "Occupant",
  finance: "Finance",
  signatory: "Signatory",
  primary: "Primary contact",
  escalation: "Escalation",
  it: "IT contact",
  general: "General",
};

const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

const EMPTY_FORM = { name: "", role: "occupant" as PersonRole, email: "", phone: "", access: true };

// ── Small presentational helpers ───────────────────────────────────────────────

function VoucherCell({ p, s }: { p: Person; s?: PersonSetup }) {
  if (!p.memberId || !p.needsVoucher) return <Badge variant="secondary" className="bg-gray-100 text-gray-700">None</Badge>;
  if (p.voucherIssued) {
    return (
      <div>
        <Badge variant="secondary" className="bg-green-100 text-green-800">Issued</Badge>
        {p.voucher?.validUntil && (
          <div className="text-xs text-muted-foreground mt-0.5">Valid to {formatDate(p.voucher.validUntil)}</div>
        )}
      </div>
    );
  }
  return (
    <Badge variant="secondary" className="bg-amber-100 text-amber-800">
      {s?.salesReason === "email_needed" ? "Needs email" : "Not issued"}
    </Badge>
  );
}

function DoorCell({ p }: { p: Person }) {
  if (!p.memberId || !p.needsDoor) return <Badge variant="secondary" className="bg-gray-100 text-gray-700">None</Badge>;
  if (!p.doorEnrolled) return <Badge variant="secondary" className="bg-amber-100 text-amber-800">Not enrolled</Badge>;
  const fullyEnrolled = p.doorStatuses.some((x) => ["fully_enrolled", "card_enrolled", "biometric_enrolled"].includes(x));
  return fullyEnrolled ? (
    <Badge variant="secondary" className="bg-green-100 text-green-800">Enrolled</Badge>
  ) : (
    <Badge variant="secondary" className="bg-blue-100 text-blue-800">Awaiting enrolment</Badge>
  );
}

function WaitingCell({ p, s }: { p: Person; s?: PersonSetup }) {
  if (!p.memberId) return <span className="text-xs text-muted-foreground">Nothing needed</span>;
  if (!s || !s.waitingOn) return <span className="text-xs text-muted-foreground">Done</span>;
  if (s.waitingOn === "sales") {
    return <Badge variant="secondary" className="bg-red-100 text-red-800">Sales: email needed</Badge>;
  }
  return <Badge variant="secondary" className="bg-amber-100 text-amber-800">IT</Badge>;
}

// ── Main component ─────────────────────────────────────────────────────────────

export function ContractPeopleAccessSection({ contractId, contractStatus, signedDocumentId, onChanged }: Props) {
  const [data, setData] = useState<PeopleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"active" | "inactive">("active");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [duplicate, setDuplicate] = useState<DuplicateInfo | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [leaving, setLeaving] = useState<Person | null>(null);
  const [leaveForm, setLeaveForm] = useState({ date: "", reason: "" });
  const [fixing, setFixing] = useState<Person | null>(null);
  const [fixForm, setFixForm] = useState({ email: "", phone: "" });
  const [wizardOpen, setWizardOpen] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/contracts/${contractId}/people`);
    if (res.ok) setData((await res.json()).data);
    setLoading(false);
  }, [contractId]);

  useEffect(() => { load(); }, [load]);

  const refresh = useCallback(async () => {
    await load();
    onChanged?.();
  }, [load, onChanged]);

  function setBusyFor(key: string, value: boolean) {
    setBusy((b) => ({ ...b, [key]: value }));
  }

  if (loading || !data) {
    return (
      <Card>
        <CardContent className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading people and access…
        </CardContent>
      </Card>
    );
  }

  const { seats, setup } = data;
  const isActiveContract = contractStatus === "active";
  const canIssueVoucher = isActiveContract && !!signedDocumentId;
  const activePeople = data.people.filter((p) => p.isActive);
  const inactivePeople = data.people.filter((p) => !p.isActive && p.memberId);
  const shown = tab === "active" ? activePeople : inactivePeople;
  const seatsFull = setup.seatsOpen === 0;
  // Nobody holds a seat yet: the wizard is the way in. After that, people are added one at a time.
  const noMembers = setup.seatsUsed === 0;

  // ── Actions ────────────────────────────────────────────────────────────────

  async function submitAdd(useExisting = false) {
    if (!form.name.trim()) { toast.error("Name is required"); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/people`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          role: form.role,
          email: form.email,
          phone: form.phone,
          give_voucher: form.access,
          give_door: form.access,
          use_existing: useExisting,
        }),
      });
      const json = await res.json();
      if (res.status === 409 && json.code === "DUPLICATE") { setDuplicate(json.existing); return; }
      if (!res.ok) { toast.error(json.error ?? "Could not add person"); return; }
      toast.success(`${form.name} added`);
      setForm(EMPTY_FORM);
      setDuplicate(null);
      setShowAdd(false);
      await refresh();
    } finally {
      setSaving(false);
    }
  }

  async function personAction(p: Person, body: Record<string, unknown>, success: string) {
    const key = `${String(body.action)}_${p.contactId}`;
    setBusyFor(key, true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/people/${p.contactId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Something went wrong"); return false; }
      toast.success(success);
      await refresh();
      return true;
    } finally {
      setBusyFor(key, false);
    }
  }

  async function issueVoucher(p: Person) {
    if (!p.email) { toast.error(`${p.name} has no email address. Add one first.`); return; }
    setBusyFor(`voucher_${p.contactId}`, true);
    try {
      const used = new Set(activePeople.map((x) => x.voucher?.seatNumber).filter((n): n is number => typeof n === "number"));
      let seat = 1;
      while (used.has(seat) && seat <= seats) seat++;
      const res = await fetch(`/api/contracts/${contractId}/vouchers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seat_number: seat, seat_occupant_email: p.email, member_id: p.memberId }),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Failed to issue voucher"); return; }
      toast.success(`Voucher issued for ${p.name}`);
      await refresh();
    } finally {
      setBusyFor(`voucher_${p.contactId}`, false);
    }
  }

  async function issueDoor(p: Person) {
    if (!confirm(`Issue door access for ${p.name}? This texts an enrolment PIN to ${p.phone}.`)) return;
    await personAction(p, { action: "issue_door" }, `Door access issued for ${p.name}`);
  }

  async function submitLeave() {
    if (!leaving) return;
    const ok = await personAction(
      leaving,
      { action: "leave", left_on: leaveForm.date || undefined, reason: leaveForm.reason || undefined },
      `${leaving.name} marked as left`
    );
    if (ok) setLeaving(null);
  }

  async function submitFix() {
    if (!fixing) return;
    const body: Record<string, string> = {};
    if (fixForm.email.trim()) body.email = fixForm.email.trim();
    if (fixForm.phone.trim()) body.phone = fixForm.phone.trim();
    if (Object.keys(body).length === 0) { toast.error("Enter an email or phone"); return; }
    const res = await fetch(`/api/contracts/${contractId}/people/${fixing.contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json();
    if (!res.ok) { toast.error(json.error ?? "Could not save"); return; }
    toast.success("Saved");
    setFixing(null);
    await refresh();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Users size={16} /> People &amp; Access
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              {setup.seatsUsed} of {seats} seats in use
              {setup.seatsOpen > 0 && ` · ${setup.seatsOpen} open`} · WiFi voucher and door access for each person
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="inline-flex rounded-md bg-muted p-1 text-sm">
              {(["active", "inactive"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTab(t)}
                  className={`rounded px-3 py-1 font-medium ${tab === t ? "bg-background shadow-sm" : "text-muted-foreground"}`}
                >
                  {t === "active" ? `Active (${activePeople.length})` : `Inactive (${inactivePeople.length})`}
                </button>
              ))}
            </div>
            {/* One obvious next action: the wizard until the first person holds a seat, then single adds. */}
            {noMembers ? (
              <Button size="sm" onClick={() => setWizardOpen(true)}>
                <Wand2 size={14} className="mr-1.5" /> Set up access
              </Button>
            ) : (
              <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
                <UserPlus size={14} className="mr-1.5" /> Add person
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-3">
        {isActiveContract && setup.state === "needs_review" && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <span className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                <b>Access setup needs review.</b> {seats} seats are paid for but no people are recorded here. Use
                Set up access to add them and arrange WiFi and door access.
              </span>
            </span>
          </div>
        )}
        {isActiveContract && setup.state === "pending" && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <b>Access setup is not complete.</b>{" "}
              {[
                setup.vouchersPending > 0 && `${setup.vouchersPending} WiFi voucher${setup.vouchersPending === 1 ? "" : "s"} not issued`,
                setup.doorPending > 0 && `${setup.doorPending} door access not enrolled`,
              ].filter(Boolean).join(", ")}
              {setup.waitingOn === "it" ? ". Waiting on IT." : ". Waiting on sales to add missing details."}
            </span>
          </div>
        )}

        {showAdd && (
          <div className="rounded-lg border bg-muted/40 p-3 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Role</Label>
                <select
                  className={selectClass}
                  value={form.role}
                  onChange={(e) => {
                    const role = e.target.value as PersonRole;
                    setForm({ ...form, role, access: DEFAULT_ACCESS_ROLES.includes(role) });
                  }}
                >
                  {PERSON_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Email</Label>
                <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.access} onCheckedChange={(v) => setForm({ ...form, access: v === true })} />
              Give WiFi voucher and door access
              <span className="text-xs text-muted-foreground">(uses a seat; on by default for occupants)</span>
            </label>
            {form.access && seatsFull && (
              <p className="text-sm text-red-700">All {seats} seats are in use. Mark someone as left or increase the seats first.</p>
            )}
            {duplicate && (
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
                <span>Someone with these details is already on this contract: <b>{duplicate.name}</b>.</span>
                <span className="flex gap-2">
                  <Button size="sm" onClick={() => submitAdd(true)} disabled={saving}>
                    {form.access && !duplicate.hasAccess ? "Use existing and give access" : "Use existing"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setDuplicate(null)}>Change details</Button>
                </span>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => { setShowAdd(false); setDuplicate(null); }}>Cancel</Button>
              <Button size="sm" onClick={() => submitAdd(false)} disabled={saving || (form.access && seatsFull)}>
                {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Add
              </Button>
            </div>
          </div>
        )}

        {shown.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {tab === "active" ? "No one added yet. Use Set up access to add people." : "No one has left this contract."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-2 pr-3 font-medium">Person</th>
                  <th className="py-2 pr-3 font-medium">WiFi voucher</th>
                  <th className="py-2 pr-3 font-medium">Door access</th>
                  <th className="py-2 font-medium">{tab === "active" ? "Waiting on" : "Left on"}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((p) => {
                  const s = setup.byContact[p.contactId];
                  return (
                    <tr key={p.contactId} className="border-b last:border-0 align-middle">
                      <td className="py-3 pr-3">
                        <div className="font-medium">{p.name}</div>
                        <div className="text-xs text-muted-foreground">
                          {ROLE_LABELS[p.role] ?? p.role}
                          {p.memberId ? "" : " · contact only"}
                          {p.isActive && p.memberId && !p.email && <span className="text-red-600"> · no email</span>}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {tab === "active" && !p.memberId && (
                            <Button
                              size="sm" variant="outline"
                              disabled={seatsFull || busy[`give_access_${p.contactId}`]}
                              title={seatsFull ? "All seats are in use" : undefined}
                              onClick={() => personAction(p, { action: "give_access" }, `${p.name} now gets access`)}
                            >
                              Give access
                            </Button>
                          )}
                          {tab === "active" && p.memberId && s?.voucherPending && !p.email && (
                            <Button size="sm" variant="outline" onClick={() => { setFixing(p); setFixForm({ email: "", phone: "" }); }}>
                              Add email
                            </Button>
                          )}
                          {tab === "active" && p.memberId && s?.voucherPending && !!p.email && (
                            <Button
                              size="sm" disabled={!canIssueVoucher || busy[`voucher_${p.contactId}`]}
                              title={!canIssueVoucher ? "Needs an active contract with a signed document" : undefined}
                              onClick={() => issueVoucher(p)}
                            >
                              {busy[`voucher_${p.contactId}`] && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                              Issue voucher
                            </Button>
                          )}
                          {tab === "active" && p.memberId && s?.doorPending && (
                            <Button
                              size="sm" variant="outline" disabled={!isActiveContract || busy[`issue_door_${p.contactId}`]}
                              onClick={() => issueDoor(p)}
                            >
                              {busy[`issue_door_${p.contactId}`] && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                              Issue door access
                            </Button>
                          )}
                          {tab === "active" && p.memberId && (
                            <Button
                              size="sm" variant="ghost"
                              onClick={() => { setLeaving(p); setLeaveForm({ date: new Date().toISOString().slice(0, 10), reason: "" }); }}
                            >
                              Mark as left
                            </Button>
                          )}
                          {tab === "inactive" && (
                            <Button
                              size="sm" variant="outline"
                              disabled={seatsFull || busy[`reactivate_${p.contactId}`]}
                              title={seatsFull ? "Needs a free seat" : undefined}
                              onClick={async () => {
                                if (await personAction(p, { action: "reactivate" }, `${p.name} is active again. Issue their access next.`)) setTab("active");
                              }}
                            >
                              Reactivate
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-3">{tab === "active" ? <VoucherCell p={p} s={s} /> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-3 pr-3">{tab === "active" ? <DoorCell p={p} /> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="py-3 pr-3">
                        {tab === "active" ? <WaitingCell p={p} s={s} /> : (
                          <span className="text-xs text-muted-foreground">
                            {p.leftOn ? formatDate(p.leftOn) : "—"}{p.leftReason ? ` · ${p.leftReason}` : ""}
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {tab === "active" && setup.seatsOpen > 0 && !noMembers && (
                  <tr className="bg-muted/40">
                    <td className="py-3 pr-3">
                      <div className="font-medium">{setup.seatsOpen === 1 ? "Open seat" : `${setup.seatsOpen} open seats`}</div>
                      <div className="text-xs text-muted-foreground">Paid for, nobody named yet</div>
                      <Button size="sm" variant="outline" className="mt-2" onClick={() => setShowAdd(true)}>Add person</Button>
                    </td>
                    <td className="py-3 pr-3 text-muted-foreground">—</td>
                    <td className="py-3 pr-3 text-muted-foreground">—</td>
                    <td className="py-3 text-xs text-muted-foreground">Does not count as incomplete</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>

      <Dialog open={!!leaving} onOpenChange={(o) => !o && setLeaving(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Mark {leaving?.name} as left</DialogTitle>
            <DialogDescription>
              Their WiFi voucher is revoked, their door access is blocked, and the seat is freed. The record is kept.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Left on</Label>
              <Input type="date" value={leaveForm.date} onChange={(e) => setLeaveForm({ ...leaveForm, date: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label>Reason (optional)</Label>
              <Input value={leaveForm.reason} onChange={(e) => setLeaveForm({ ...leaveForm, reason: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setLeaving(null)}>Cancel</Button>
            <Button onClick={submitLeave} disabled={!!leaving && busy[`leave_${leaving.contactId}`]}>Mark as left</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fixing} onOpenChange={(o) => !o && setFixing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add details for {fixing?.name}</DialogTitle>
            <DialogDescription>A WiFi voucher is emailed, so it needs an email address.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>Email</Label>
              <Input type="email" value={fixForm.email} onChange={(e) => setFixForm({ ...fixForm, email: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setFixing(null)}>Cancel</Button>
            <Button onClick={submitFix}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ContractAccessSetupWizard
        open={wizardOpen}
        onOpenChange={setWizardOpen}
        contractId={contractId}
        seatsOpen={setup.seatsOpen}
        onDone={refresh}
      />
    </Card>
  );
}

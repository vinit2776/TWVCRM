"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { DEFAULT_ACCESS_ROLES, PERSON_ROLES, type PersonRole } from "@/lib/contract-people";

interface Row {
  key: number;
  name: string;
  role: PersonRole;
  email: string;
  phone: string;
  voucher: boolean;
  door: boolean;
  error?: string;
  done?: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contractId: string;
  /** Seats not yet taken by an active member. */
  seatsOpen: number;
  onDone: () => void | Promise<void>;
}

const ROLE_LABELS: Record<PersonRole, string> = {
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

let nextKey = 1;
const blankRow = (): Row => ({ key: nextKey++, name: "", role: "occupant", email: "", phone: "", voucher: true, door: true });

const hasAccess = (r: Row) => r.voucher || r.door;

/**
 * First-time setup for a contract's people. Step 1 names everyone, step 2 says
 * what each person needs, step 3 reviews and saves. Saving records the people
 * only; vouchers and door access are issued afterwards from the People & Access
 * panel (normally by IT), so nothing is sent to anyone from this dialog.
 */
export function ContractAccessSetupWizard({ open, onOpenChange, contractId, seatsOpen, onDone }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [rows, setRows] = useState<Row[]>(() => [blankRow()]);
  const [saving, setSaving] = useState(false);

  const filled = rows.filter((r) => r.name.trim());
  const seatsNeeded = filled.filter(hasAccess).length;
  const overSeats = seatsNeeded > seatsOpen;

  function update(key: number, patch: Partial<Row>) {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }

  function setRole(key: number, role: PersonRole) {
    const access = DEFAULT_ACCESS_ROLES.includes(role);
    update(key, { role, voucher: access, door: access });
  }

  function reset() {
    setStep(1);
    setRows([blankRow()]);
  }

  function close(next: boolean) {
    if (!next && !saving) reset();
    onOpenChange(next);
  }

  function step1Problem(): string | null {
    if (filled.length === 0) return "Add at least one person";
    return null;
  }

  function step2Problems(): string[] {
    const problems: string[] = [];
    for (const r of filled) {
      if (hasAccess(r) && r.phone.replace(/\D/g, "").length < 10) problems.push(`${r.name}: phone number needed for access`);
    }
    if (overSeats) problems.push(`${seatsNeeded} people need a seat but only ${seatsOpen} ${seatsOpen === 1 ? "is" : "are"} open`);
    return problems;
  }

  async function save() {
    setSaving(true);
    let failed = 0;
    const next: Row[] = [];
    for (const r of rows) {
      if (!r.name.trim() || r.done) { next.push(r); continue; }
      const res = await fetch(`/api/contracts/${contractId}/people`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: r.name, role: r.role, email: r.email, phone: r.phone,
          give_voucher: r.voucher, give_door: r.door,
        }),
      });
      if (res.ok) next.push({ ...r, done: true, error: undefined });
      else {
        failed++;
        const json = await res.json().catch(() => ({}));
        next.push({ ...r, error: json.error ?? "Could not add" });
      }
    }
    setRows(next);
    setSaving(false);
    await onDone();
    if (failed === 0) {
      toast.success(`${filled.length} ${filled.length === 1 ? "person" : "people"} saved`);
      reset();
      onOpenChange(false);
    } else {
      toast.error(`${failed} could not be added. Fix them and save again.`);
      setStep(1);
    }
  }

  const problems = step === 2 ? step2Problems() : [];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Set up access</DialogTitle>
          <DialogDescription>
            Step {step} of 3 · {step === 1 ? "People" : step === 2 ? "What each person needs" : "Review"}
          </DialogDescription>
        </DialogHeader>

        {step === 1 && (
          <div className="space-y-2">
            <div className="hidden grid-cols-[1.3fr_1fr_1.4fr_1fr_auto] gap-2 text-xs text-muted-foreground sm:grid">
              <span>Name</span><span>Role</span><span>Email</span><span>Phone</span><span className="w-16" />
            </div>
            {rows.map((r) => (
              <div key={r.key} className="space-y-1">
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1.3fr_1fr_1.4fr_1fr_auto]">
                  <Input placeholder="Name" value={r.name} disabled={r.done} onChange={(e) => update(r.key, { name: e.target.value })} />
                  <select className={selectClass} value={r.role} disabled={r.done} onChange={(e) => setRole(r.key, e.target.value as PersonRole)}>
                    {PERSON_ROLES.map((x) => <option key={x} value={x}>{ROLE_LABELS[x]}</option>)}
                  </select>
                  <Input placeholder="Email" type="email" value={r.email} disabled={r.done} onChange={(e) => update(r.key, { email: e.target.value })} />
                  <Input placeholder="Phone" value={r.phone} disabled={r.done} onChange={(e) => update(r.key, { phone: e.target.value })} />
                  <Button
                    type="button" variant="ghost" size="sm" className="w-16"
                    disabled={r.done || rows.length === 1}
                    onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}
                  >
                    Remove
                  </Button>
                </div>
                {r.error && <p className="text-xs text-red-600">{r.error}</p>}
                {r.done && <p className="text-xs text-green-700">Saved</p>}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" onClick={() => setRows((rs) => [...rs, blankRow()])}>
              + Add another person
            </Button>
            <p className="text-xs text-muted-foreground">
              {seatsOpen} {seatsOpen === 1 ? "seat is" : "seats are"} open. You can leave seats open and add people later from the contract page.
            </p>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-3 font-medium">Person</th>
                    <th className="py-2 pr-3 font-medium">WiFi voucher</th>
                    <th className="py-2 pr-3 font-medium">Door access</th>
                    <th className="py-2 font-medium">Check</th>
                  </tr>
                </thead>
                <tbody>
                  {filled.map((r) => (
                    <tr key={r.key} className="border-b last:border-0">
                      <td className="py-2 pr-3">
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-muted-foreground">{ROLE_LABELS[r.role]}</div>
                      </td>
                      <td className="py-2 pr-3">
                        <label className="flex items-center gap-2"><Checkbox checked={r.voucher} disabled={r.done} onCheckedChange={(v) => update(r.key, { voucher: v === true })} /> Voucher</label>
                      </td>
                      <td className="py-2 pr-3">
                        <label className="flex items-center gap-2"><Checkbox checked={r.door} disabled={r.done} onCheckedChange={(v) => update(r.key, { door: v === true })} /> Door</label>
                      </td>
                      <td className="py-2 text-xs">
                        {!hasAccess(r) ? <span className="text-muted-foreground">Contact only, no seat</span>
                          : r.phone.replace(/\D/g, "").length < 10 ? <span className="text-red-600">Phone needed</span>
                          : r.voucher && !r.email.trim() ? <span className="text-amber-700">No email yet, voucher can&apos;t be issued until added</span>
                          : <span className="text-green-700">Ready</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              Occupants get both by default. Finance and signatory contacts get none and can be given access later.
            </p>
            {problems.length > 0 && (
              <ul className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {problems.map((p) => <li key={p}>{p}</li>)}
              </ul>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="rounded-lg border p-3"><b>{filled.length} {filled.length === 1 ? "person" : "people"}</b><div className="text-xs text-muted-foreground">{filled.length - seatsNeeded} contact only</div></div>
              <div className="rounded-lg border p-3"><b>{filled.filter((r) => r.voucher).length} WiFi {filled.filter((r) => r.voucher).length === 1 ? "voucher" : "vouchers"}</b><div className="text-xs text-muted-foreground">{filled.filter((r) => r.voucher && !r.email.trim()).length} still need an email</div></div>
              <div className="rounded-lg border p-3"><b>{filled.filter((r) => r.door).length} door-access {filled.filter((r) => r.door).length === 1 ? "user" : "users"}</b><div className="text-xs text-muted-foreground">{Math.max(0, seatsOpen - seatsNeeded)} {Math.max(0, seatsOpen - seatsNeeded) === 1 ? "seat" : "seats"} left open</div></div>
            </div>
            <p className="text-sm text-muted-foreground">
              Saving records these people. Nothing is sent to them yet: WiFi vouchers and door access are issued next from the
              People &amp; Access panel, usually by IT.
            </p>
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <span className="text-xs text-muted-foreground self-center">Step {step} of 3</span>
          <span className="flex gap-2">
            {step > 1 && <Button variant="outline" disabled={saving} onClick={() => setStep((s) => (s - 1) as 1 | 2)}>Back</Button>}
            {step === 1 && (
              <Button onClick={() => { const p = step1Problem(); if (p) toast.error(p); else setStep(2); }}>Next: Access</Button>
            )}
            {step === 2 && <Button disabled={problems.length > 0} onClick={() => setStep(3)}>Next: Review</Button>}
            {step === 3 && (
              <Button onClick={save} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Save people
              </Button>
            )}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

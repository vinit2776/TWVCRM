"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FollowUpDateTimeInput } from "@/components/shared/followup-datetime-input";
import { useLocations } from "@/hooks/use-locations";
import { WORKSPACE_TYPES, WORKSPACE_TYPE_LABELS } from "@/lib/constants";
import { pushTrailEntry } from "@/lib/nav-trail";
import type { ContactBackHints, ContactBackPrefill } from "@/lib/contact-back";

const chip = (on: boolean) =>
  `rounded-full border px-4 py-2 text-sm min-h-10 ${on ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted"}`;

function Step({ n, title, hint, said, children }: { n: number; title: string; hint?: string; said?: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3 border-t pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{n}</span>
        <h2 className="font-semibold">{title}</h2>
        {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      </div>
      {said && <p className="text-xs text-muted-foreground">Form said: {said}</p>}
      {children}
    </section>
  );
}

const num = (v: string) => (v.trim() === "" ? undefined : Number(v));

/** Set when the form is opened from a public-form enquiry card to call the customer back. */
export interface ContactBack {
  enquiryId: string;
  leadId: string;
  prefill: ContactBackPrefill;
  hints: ContactBackHints;
}

/**
 * Logging a call that is happening now. The requirement comes first (where, what, how many, what
 * price), because that is what the caller can answer straight away; how to reach them comes after.
 * Save stays off until the essentials are there, and a number that already belongs to a lead offers
 * to log the call on that lead instead of making a second one.
 *
 * Opened from an enquiry card (`contactBack`), it is the same form already filled from what the
 * customer submitted, with "Form said" beside each step so the caller corrects rather than retypes.
 * Saving logs the call on the enquiry's lead, claims the enquiry and sets the next step.
 */
export function CallInLeadForm({ onUseFullForm, contactBack }: { onUseFullForm?: () => void; contactBack?: ContactBack }) {
  const router = useRouter();
  const { locations } = useLocations();
  const pre = contactBack?.prefill;
  const hints = contactBack?.hints;

  const [locationIds, setLocationIds] = useState<string[]>(pre?.locationIds ?? []);
  const [types, setTypes] = useState<string[]>(pre?.types ?? []);
  const [seats, setSeats] = useState(pre?.seats ?? 1);
  const [startDate, setStartDate] = useState(pre?.startDate ?? "");
  const [quoted, setQuoted] = useState("");
  const [budget, setBudget] = useState(pre?.budget ?? "");
  const [requests, setRequests] = useState("");
  const [phone, setPhone] = useState(pre?.phone ?? "");
  const [email, setEmail] = useState(pre?.email ?? "");
  const [name, setName] = useState(pre?.name ?? "");
  const [company, setCompany] = useState(pre?.company ?? "");
  const [followUp, setFollowUp] = useState("");
  const [followUpNote, setFollowUpNote] = useState("");
  const [pin, setPin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [existing, setExisting] = useState<{ id: string; name: string } | null>(null);

  // Functional updates, so two quick taps never overwrite each other.
  const toggle = (set: React.Dispatch<React.SetStateAction<string[]>>, v: string) =>
    set((list) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]));

  // Is this number already a lead? Checked once enough digits are typed.
  useEffect(() => {
    const digits = phone.replace(/\D/g, "");
    if (contactBack || digits.length < 10) {
      setExisting(null);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      fetch(`/api/leads?phone_exact=${encodeURIComponent(phone.trim())}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((json) => {
          if (cancelled) return;
          const hit = json?.data?.[0];
          setExisting(hit ? { id: hit.id, name: `${hit.first_name} ${hit.last_name ?? ""}`.trim() } : null);
        })
        .catch(() => {});
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [phone, contactBack]);

  const emailOk = !email.trim() || /^\S+@\S+\.\S+$/.test(email.trim());
  const canSave =
    locationIds.length > 0 &&
    types.length > 0 &&
    seats >= 1 &&
    (phone.trim() !== "" || email.trim() !== "") &&
    emailOk &&
    !!followUp &&
    !!followUpNote.trim();

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const res = await fetch("/api/leads/call-in", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_ids: locationIds,
          workspace_types: types,
          seats,
          start_date: startDate || undefined,
          quoted_per_seat: num(quoted),
          budget_per_seat: num(budget),
          requests: requests.trim() || undefined,
          phone: phone.trim() || undefined,
          email: email.trim() || undefined,
          name: name.trim() || undefined,
          company: company.trim() || undefined,
          follow_up_date: followUp,
          follow_up_notes: followUpNote.trim(),
          existing_lead_id: contactBack?.leadId ?? existing?.id,
          enquiry_id: contactBack?.enquiryId,
          pin: pin || undefined,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.details?.[0]?.message ?? json.error ?? "Could not save the call");
        return;
      }
      const { lead_id, created } = json.data as { lead_id: string; created: boolean };
      if (json.warning) toast.warning(json.warning);
      else toast.success(contactBack ? "Call logged and the enquiry is yours" : created ? "Lead saved and the next step is set" : "Call logged on the existing lead");
      pushTrailEntry({ href: `/leads/${lead_id}/activity`, label: name.trim() || existing?.name || "Inbound call" });
      router.push(`/leads/${lead_id}/activity`);
    } finally {
      setSaving(false);
    }
  };

  // Resolves the enquiry without a call (not interested, or followed up with no response).
  const closeEnquiry = async (outcome: "not_interested" | "no_response") => {
    if (!contactBack || saving) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/enquiries/${contactBack.enquiryId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outcome }),
      });
      if (!res.ok) {
        toast.error((await res.json().catch(() => ({}))).error ?? "Could not close the enquiry");
        return;
      }
      toast.success(outcome === "not_interested" ? "Closed as not interested" : "Closed as no response");
      router.push("/leads");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-5 rounded-lg border p-4 sm:p-6">
      <Step n={1} title="Which location?" hint="pick more than one if they are open to it" said={hints?.location}>
        <div className="flex flex-wrap gap-2">
          {locations.map((l) => (
            <button key={l.id} type="button" className={chip(locationIds.includes(l.id))} onClick={() => toggle(setLocationIds, l.id)}>
              {l.name}
            </button>
          ))}
        </div>
      </Step>

      <Step n={2} title="What are they looking for?" hint="one or more" said={hints?.type}>
        <div className="flex flex-wrap gap-2">
          {WORKSPACE_TYPES.map((t) => (
            <button key={t} type="button" className={chip(types.includes(t))} onClick={() => toggle(setTypes, t)}>
              {WORKSPACE_TYPE_LABELS[t] ?? t}
            </button>
          ))}
        </div>
      </Step>

      <Step n={3} title="How many seats?" said={hints?.seatsAndStart}>
        <div className="flex flex-wrap items-center gap-4">
          <div className="inline-flex items-center overflow-hidden rounded-lg border">
            <button type="button" className="h-11 w-11 text-lg hover:bg-muted" onClick={() => setSeats((s) => Math.max(1, s - 1))} aria-label="Fewer seats">−</button>
            <span className="w-12 text-center text-lg font-semibold">{seats}</span>
            <button type="button" className="h-11 w-11 text-lg hover:bg-muted" onClick={() => setSeats((s) => s + 1)} aria-label="More seats">+</button>
          </div>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            Start date (optional)
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="w-44" />
          </label>
        </div>
      </Step>

      <Step n={4} title="Price" hint="either or both, per seat per month" said={hints?.budget}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">What we quoted (₹)</span>
            <Input type="number" inputMode="numeric" min={0} value={quoted} onChange={(e) => setQuoted(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Their budget (₹)</span>
            <Input type="number" inputMode="numeric" min={0} value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
        </div>
      </Step>

      <Step n={5} title="Anything else they asked for?" hint="optional">
        <Textarea rows={2} value={requests} onChange={(e) => setRequests(e.target.value)} placeholder="e.g. near a metro, wants a tour this week, needs parking" />
      </Step>

      <Step n={6} title="Their details" hint={contactBack ? "from the form, edit if needed" : "a phone number or an email, at least one"}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Phone</span>
            <Input type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Email</span>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Name (optional)</span>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">Company (optional)</span>
            <Input value={company} onChange={(e) => setCompany(e.target.value)} />
          </label>
        </div>
        {!emailOk && <p className="text-xs text-red-600">That email doesn&apos;t look right.</p>}
        {existing && (
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
            This number is already a lead: <b>{existing.name}</b>.{" "}
            <Link href={`/leads/${existing.id}/activity`} className="font-medium text-primary underline">Open it</Link>. Saving will log this call on that lead instead of making a duplicate.
          </div>
        )}
      </Step>

      <Step n={7} title="Next step" hint="required">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1 text-sm">
            <span className="text-muted-foreground">Call back on</span>
            <FollowUpDateTimeInput value={followUp} onChange={setFollowUp} />
          </div>
          <label className="space-y-1 text-sm">
            <span className="text-muted-foreground">What needs to happen?</span>
            <Input value={followUpNote} onChange={(e) => setFollowUpNote(e.target.value)} placeholder="e.g. Send pricing, book a tour" />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={pin} onChange={(e) => setPin(e.target.checked)} className="h-4 w-4" />
          <span><b>Pin this enquiry</b> <span className="text-muted-foreground">stays highlighted on every calendar day until you unpin it</span></span>
        </label>
        <p className="text-xs text-muted-foreground">You will be the person handling this lead. You can hand it over from its page.</p>
      </Step>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        {contactBack ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            <span>Close without a call:</span>
            <button type="button" disabled={saving} onClick={() => closeEnquiry("not_interested")} className="underline underline-offset-2 hover:text-foreground">
              Not interested
            </button>
            <button type="button" disabled={saving} onClick={() => closeEnquiry("no_response")} className="underline underline-offset-2 hover:text-foreground">
              No response
            </button>
          </div>
        ) : (
          <button type="button" onClick={onUseFullForm} className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground">
            Use the full lead form
          </button>
        )}
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => router.back()}>Cancel</Button>
          <Button type="button" disabled={!canSave || saving} onClick={save}>
            {saving && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {contactBack ? "Save & claim" : existing ? "Log call on that lead" : "Save lead"}
          </Button>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import {
  AGREEMENT_FACILITIES, DEFAULT_AMENITY_KEYS, MAX_TERM_LINES, MAX_TERM_LINE_LENGTH,
  STANDARD_GENERAL_TERMS, STANDARD_FACILITY_TERMS, buildScheduleLines, standardAgreementTerms,
  type AgreementTerms, type FacilityTerms,
} from "@/lib/agreement-terms";

/** One textarea per list; one line in the box is one bullet in the agreement. */
type SectionText = { inclusions: string; paid: string; rates: string };
type TermsText = { general: SectionText; facilities: Record<string, SectionText> };

const toText = (t: FacilityTerms): SectionText => ({
  inclusions: t.inclusions.join("\n"), paid: t.paid.join("\n"), rates: t.rates.join("\n"),
});
const toLines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);
const toTerms = (t: SectionText): FacilityTerms => ({
  inclusions: toLines(t.inclusions), paid: toLines(t.paid), rates: toLines(t.rates),
});

function textFromTerms(terms: AgreementTerms | null | undefined): TermsText {
  const base = terms ?? standardAgreementTerms();
  const standard = standardAgreementTerms();
  return {
    general: toText(base.general),
    // A facility the saved terms predate starts from its standard wording.
    facilities: Object.fromEntries(
      AGREEMENT_FACILITIES.map(({ key }) => [key, toText(base.facilities[key] ?? standard.facilities[key])])
    ),
  };
}

const termsFromText = (t: TermsText): AgreementTerms => ({
  general: toTerms(t.general),
  facilities: Object.fromEntries(Object.entries(t.facilities).map(([k, v]) => [k, toTerms(v)])),
});

const FIELDS: Array<{ field: keyof SectionText; label: string; hint: string }> = [
  { field: "inclusions", label: "Included in membership", hint: "Schedule row 4" },
  { field: "paid", label: "Paid beyond complimentary", hint: "Schedule row 6" },
  { field: "rates", label: "Rack rate", hint: "Schedule row 7" },
];

function Section({
  title, value, onChange, onReset, canEdit,
}: {
  title: string;
  value: SectionText;
  onChange: (next: SectionText) => void;
  onReset?: () => void;
  canEdit: boolean;
}) {
  return (
    <div className="rounded-lg border p-3 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{title}</p>
        {canEdit && onReset && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onReset}>Reset to standard wording</Button>
        )}
      </div>
      {FIELDS.map(({ field, label, hint }) => (
        <div key={field} className="space-y-1">
          <Label className="text-xs text-muted-foreground">{label} <span className="opacity-70">({hint})</span></Label>
          <Textarea
            rows={Math.max(2, value[field].split("\n").length)}
            className="min-h-0 text-xs"
            value={value[field]}
            disabled={!canEdit}
            maxLength={MAX_TERM_LINES * (MAX_TERM_LINE_LENGTH + 1)}
            placeholder="Nothing for this facility"
            onChange={(e) => onChange({ ...value, [field]: e.target.value })}
          />
        </div>
      ))}
    </div>
  );
}

interface AgreementTermsCardProps {
  locationId: string;
  canEdit: boolean;
  /** Current (possibly unsaved) facility ticks from the Proposal Amenities card above. */
  amenityIcons: string[];
  initialTerms?: AgreementTerms | null;
}

export function AgreementTermsCard({ locationId, canEdit, amenityIcons, initialTerms }: AgreementTermsCardProps) {
  const [custom, setCustom] = useState(Boolean(initialTerms));
  const [text, setText] = useState<TermsText>(() => textFromTerms(initialTerms));
  const [saving, setSaving] = useState(false);

  const ticked = amenityIcons.length > 0 || initialTerms ? amenityIcons : DEFAULT_AMENITY_KEYS;
  const tickedFacilities = AGREEMENT_FACILITIES.filter((f) => ticked.includes(f.key));
  const missingFacilities = AGREEMENT_FACILITIES.filter((f) => !ticked.includes(f.key));

  const preview = useMemo(() => buildScheduleLines(termsFromText(text), ticked), [text, ticked]);

  const tooLong = useMemo(() => {
    const t = termsFromText(text);
    return [t.general, ...Object.values(t.facilities)].some((s) =>
      [s.inclusions, s.paid, s.rates].some((l) => l.length > MAX_TERM_LINES || l.some((x) => x.length > MAX_TERM_LINE_LENGTH)));
  }, [text]);

  const save = async (terms: AgreementTerms | null, done: string) => {
    setSaving(true);
    const res = await fetch(`/api/locations/${locationId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agreement_terms: terms }),
    });
    setSaving(false);
    if (res.ok) { toast.success(done); return true; }
    const err = await res.json().catch(() => null);
    toast.error(err?.error || "Failed to save agreement terms");
    return false;
  };

  const goStandard = async () => {
    if (!window.confirm("Put this location back on the standard agreement wording? Your edits will be deleted.")) return;
    if (await save(null, "Back on the standard agreement wording")) {
      setText(textFromTerms(null));
      setCustom(false);
    }
  };

  const setFacility = (key: string, next: SectionText) =>
    setText((prev) => ({ ...prev, facilities: { ...prev.facilities, [key]: next } }));

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Agreement Terms</CardTitle>
        <p className="text-xs text-muted-foreground mt-0.5">
          The wording for this location&apos;s membership agreement Schedule (rows 4, 6 and 7). Each line is printed exactly as typed, one bullet per line.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {!custom ? (
          <div className="flex items-center justify-between gap-4 rounded-lg border border-dashed p-4">
            <p className="text-sm text-muted-foreground">
              This location uses the standard agreement wording, the same as every other location.
            </p>
            {canEdit && (
              <Button size="sm" onClick={() => { setText(textFromTerms(null)); setCustom(true); }}>
                Customise terms
              </Button>
            )}
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Only the facilities ticked in Proposal Amenities above are printed. Save amenities first, then save the terms.
            </p>
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
              <div className="space-y-3">
                <Section
                  title="General (always printed)"
                  value={text.general}
                  canEdit={canEdit}
                  onChange={(next) => setText((p) => ({ ...p, general: next }))}
                  onReset={() => setText((p) => ({ ...p, general: toText(STANDARD_GENERAL_TERMS) }))}
                />
                {tickedFacilities.map(({ key, label }) => (
                  <Section
                    key={key}
                    title={label}
                    value={text.facilities[key]}
                    canEdit={canEdit}
                    onChange={(next) => setFacility(key, next)}
                    onReset={() => setFacility(key, toText(STANDARD_FACILITY_TERMS[key] ?? { inclusions: [], paid: [], rates: [] }))}
                  />
                ))}
                {missingFacilities.length > 0 && (
                  <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
                    Not offered here, so not printed: {missingFacilities.map((f) => f.label).join(", ")}.
                  </p>
                )}
              </div>

              <div className="rounded-lg border bg-muted/30 p-3 space-y-3 self-start text-xs">
                <p className="text-sm font-medium">Agreement preview</p>
                {([["4. Inclusions", preview.inclusions], ["6. Additional paid services", preview.paid], ["7. Rack rates", preview.rates]] as const).map(
                  ([title, lines]) => (
                    <div key={title}>
                      <p className="font-medium">{title}</p>
                      {lines.length === 0 ? (
                        <p className="text-muted-foreground">Nil</p>
                      ) : (
                        <ul className="space-y-0.5 text-muted-foreground">
                          {lines.map((l, i) => <li key={i}>• {l}</li>)}
                        </ul>
                      )}
                    </div>
                  )
                )}
              </div>
            </div>

            {tooLong && (
              <p className="text-xs text-red-600">
                Keep each line under {MAX_TERM_LINE_LENGTH} characters and use at most {MAX_TERM_LINES} lines per box.
              </p>
            )}
            {canEdit && (
              <div className="flex justify-between">
                <Button size="sm" variant="ghost" onClick={goStandard} disabled={saving}>Use standard wording</Button>
                <Button size="sm" disabled={saving || tooLong} onClick={() => save(termsFromText(text), "Agreement terms saved")}>
                  {saving ? "Saving…" : "Save terms"}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

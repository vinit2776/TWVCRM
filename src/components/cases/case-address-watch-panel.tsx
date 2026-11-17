"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDate } from "@/lib/utils";
import {
  ADDRESS_CHECK_SOURCES,
  ADDRESS_CHECK_SOURCE_LABELS,
  ADDRESS_FINDINGS,
  ADDRESS_FINDING_LABELS,
  type AddressCheckSource,
  type AddressFinding,
} from "@/lib/vo-address-evidence";
import { holdoverNoticeDraft } from "@/lib/vo-holdover-pi";

interface Check {
  id: string;
  checked_at: string;
  day_offset: number;
  source: AddressCheckSource;
  result: string | null;
  verdict: string;
  evidence_ref: string | null;
  finding: AddressFinding | null;
}

interface WatchState {
  available: boolean;
  can_record?: boolean;
  status?: string | null;
  address_status?: string | null;
  release_ready?: boolean;
  checks: Check[];
}

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";

/**
 * Evidence trail for the post-lapse address watch, with a form to record a
 * public-record check by hand. Renders nothing until the case has lapsed and
 * the database update has landed. Nothing here contacts the customer.
 */
export function CaseAddressWatchPanel({ caseId, onChanged }: { caseId: string; onChanged?: () => void }) {
  const [state, setState] = useState<WatchState | null>(null);
  const [loading, setLoading] = useState(true);
  const [source, setSource] = useState<AddressCheckSource>("gst_portal");
  const [finding, setFinding] = useState<AddressFinding>("found_using");
  const [checkedOn, setCheckedOn] = useState(() => new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }));
  const [note, setNote] = useState("");
  const [evidenceRef, setEvidenceRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [releaseReason, setReleaseReason] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cases/${caseId}/address-checks`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load");
      setState(json.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load the address checks");
    } finally {
      setLoading(false);
    }
  }, [caseId]);

  useEffect(() => {
    load();
  }, [load]);

  async function send(method: "POST" | "PATCH", body: Record<string, unknown>, done: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/address-checks`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Could not save");
      toast.success(done);
      setNote("");
      setEvidenceRef("");
      setReleaseReason("");
      await load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading address checks…
      </div>
    );
  }
  if (!state || !state.available || state.status !== "lapsed") return null;

  const released = state.address_status === "released";
  const draft = holdoverNoticeDraft({
    customerName: "[customer name]",
    addressLine: "[our address]",
    piNumber: "[PI number]",
    amountWithGst: "[amount]",
    periodLabel: "[period]",
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          Address watch
          {released ? <Badge variant="secondary">Address released</Badge> : state.release_ready ? <Badge>Ready to release</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-sm text-muted-foreground">
          Record what the public record shows for our address. Nothing here contacts the customer or raises a bill.
        </p>

        <ol className="space-y-2">
          {state.checks.length === 0 && <li className="text-sm text-muted-foreground">No checks recorded yet.</li>}
          {state.checks.map((c) => (
            <li key={c.id} className="rounded-md border p-3 text-sm space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{formatDate(c.checked_at)}</span>
                <span className="text-muted-foreground">day {c.day_offset} · {ADDRESS_CHECK_SOURCE_LABELS[c.source] ?? c.source}</span>
                <Badge variant="outline">{c.finding ? ADDRESS_FINDING_LABELS[c.finding] : c.verdict}</Badge>
              </div>
              {c.result && <p>{c.result}</p>}
              {c.evidence_ref && <p className="text-xs text-muted-foreground">Reference: {c.evidence_ref}</p>}
            </li>
          ))}
        </ol>

        {state.can_record && !released && (
          <div className="space-y-3 rounded-md border p-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="aw-source">Source</Label>
                <select id="aw-source" className={SELECT_CLASS} value={source} onChange={(e) => setSource(e.target.value as AddressCheckSource)}>
                  {ADDRESS_CHECK_SOURCES.map((s) => <option key={s} value={s}>{ADDRESS_CHECK_SOURCE_LABELS[s]}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="aw-finding">Finding</Label>
                <select id="aw-finding" className={SELECT_CLASS} value={finding} onChange={(e) => setFinding(e.target.value as AddressFinding)}>
                  {ADDRESS_FINDINGS.map((f) => <option key={f} value={f}>{ADDRESS_FINDING_LABELS[f]}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="aw-date">Checked on</Label>
                <Input id="aw-date" type="date" value={checkedOn} onChange={(e) => setCheckedOn(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="aw-note">What you saw</Label>
              <Textarea id="aw-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="aw-ref">File or screenshot reference (optional)</Label>
              <Input id="aw-ref" value={evidenceRef} onChange={(e) => setEvidenceRef(e.target.value)} />
            </div>
            <Button
              size="sm"
              disabled={saving || note.trim().length < 5}
              onClick={() => send("POST", { source, finding, checked_on: checkedOn, note, evidence_ref: evidenceRef || undefined }, "Check recorded")}
            >
              {saving ? "Saving…" : "Record check"}
            </Button>
          </div>
        )}

        {state.can_record && !released && state.release_ready && (
          <div className="space-y-2 rounded-md border border-emerald-300 p-3">
            <Label htmlFor="aw-release">Release the address (reason)</Label>
            <Textarea id="aw-release" rows={2} value={releaseReason} onChange={(e) => setReleaseReason(e.target.value)} />
            <Button size="sm" variant="outline" disabled={saving || releaseReason.trim().length < 10} onClick={() => send("PATCH", { action: "release", reason: releaseReason }, "Address released")}>
              Confirm release
            </Button>
          </div>
        )}

        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">Draft customer notice (copy and send yourself)</summary>
          <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted p-3 text-xs">{draft}</pre>
          <Button size="sm" variant="ghost" onClick={() => navigator.clipboard.writeText(draft).then(() => toast.success("Copied"))}>
            Copy
          </Button>
        </details>
      </CardContent>
    </Card>
  );
}

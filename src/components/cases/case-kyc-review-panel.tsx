"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  KYC_PORTAL_CHECK_LABELS,
  KYC_PORTAL_CHECK_RESULTS,
  KYC_PORTAL_CHECK_RESULT_COLORS,
  KYC_PORTAL_CHECK_RESULT_LABELS,
  KYC_PORTAL_CHECK_TYPES,
} from "@/lib/constants";
import { KYC_ACK_REASON_MIN_LENGTH } from "@/lib/vo-kyc-review";

interface Warning { code: string; severity: string; message: string }
interface PortalRow { check_type: string; result: string; evidence_note: string | null }
interface ReviewState {
  available: boolean;
  step?: "not_started" | "awaiting_signoff" | "reviewed";
  checks_run_at?: string | null;
  reviewed_at?: string | null;
  warnings?: Warning[];
  portal_checks?: PortalRow[];
  can_prepare?: boolean;
  can_sign_off?: boolean;
}

type PortalDraft = Record<string, { result: string; note: string }>;

const STEP_LABEL = {
  not_started: "Step 1: run checks",
  awaiting_signoff: "Step 2: awaiting manager sign-off",
  reviewed: "KYC reviewed",
} as const;

export function CaseKycReviewPanel({ caseId }: { caseId: string }) {
  const [state, setState] = useState<ReviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [portal, setPortal] = useState<PortalDraft>({});
  const [details, setDetails] = useState({ mca_name: "", signatory_name: "", signatory_pan: "", signatory_aadhaar: "", certificate_issued_on: "" });
  const [ackOn, setAckOn] = useState<Record<string, boolean>>({});
  const [ackReason, setAckReason] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch(`/api/cases/${caseId}/kyc-review`);
    const json = res.ok ? await res.json() : null;
    setState(json?.data ?? { available: false });
  }, [caseId]);

  useEffect(() => {
    load().catch(() => setState({ available: false }));
  }, [load]);

  // Hidden until migration 00681 is applied, or if the state could not be read.
  if (!state?.available) return null;

  async function post(path: string, body: unknown, ok: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/kyc-review/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error || "Request failed");
        return;
      }
      toast.success(ok);
      setAckOn({});
      setAckReason({});
      await load();
    } finally {
      setBusy(false);
    }
  }

  function runChecks() {
    const clean = Object.fromEntries(Object.entries(details).filter(([, v]) => v.trim()));
    const portal_checks = Object.entries(portal)
      .filter(([, v]) => v.result)
      .map(([check_type, v]) => ({ check_type, result: v.result, evidence_note: v.note.trim() || undefined }));
    void post("run-checks", { ...clean, portal_checks }, "Checks recorded");
  }

  const warnings = state.warnings ?? [];
  const step = state.step ?? "not_started";
  const answered = warnings.every(
    (w) => ackOn[w.code] && (ackReason[w.code] ?? "").trim().length >= KYC_ACK_REASON_MIN_LENGTH,
  );

  return (
    <div className="mt-6 space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">KYC review</h3>
        <Badge variant="outline">{STEP_LABEL[step]}</Badge>
      </div>

      {warnings.length > 0 && (
        <ul className="space-y-1 text-sm">
          {warnings.map((w) => (
            <li key={w.code} className="rounded bg-amber-50 px-2 py-1 text-amber-900">{w.message}</li>
          ))}
        </ul>
      )}

      {(state.portal_checks ?? []).length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          {state.portal_checks!.map((p) => (
            <span key={p.check_type} className={`rounded px-2 py-1 ${KYC_PORTAL_CHECK_RESULT_COLORS[p.result as keyof typeof KYC_PORTAL_CHECK_RESULT_COLORS] ?? ""}`}>
              {KYC_PORTAL_CHECK_LABELS[p.check_type as keyof typeof KYC_PORTAL_CHECK_LABELS] ?? p.check_type}:{" "}
              {KYC_PORTAL_CHECK_RESULT_LABELS[p.result as keyof typeof KYC_PORTAL_CHECK_RESULT_LABELS] ?? p.result}
            </span>
          ))}
        </div>
      )}

      {state.can_prepare && step !== "reviewed" && (
        <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input placeholder="Company name on MCA" value={details.mca_name} onChange={(e) => setDetails({ ...details, mca_name: e.target.value })} />
            <Input placeholder="Signatory name" value={details.signatory_name} onChange={(e) => setDetails({ ...details, signatory_name: e.target.value })} />
            <Input placeholder="Signatory PAN" value={details.signatory_pan} onChange={(e) => setDetails({ ...details, signatory_pan: e.target.value })} />
            <Input placeholder="Signatory Aadhaar (stored masked)" value={details.signatory_aadhaar} onChange={(e) => setDetails({ ...details, signatory_aadhaar: e.target.value })} />
            <Input type="date" aria-label="Certificate issued on" value={details.certificate_issued_on} onChange={(e) => setDetails({ ...details, certificate_issued_on: e.target.value })} />
          </div>
          {KYC_PORTAL_CHECK_TYPES.map((t) => (
            <div key={t} className="grid items-center gap-2 sm:grid-cols-[1fr_160px_1fr]">
              <span className="text-sm">{KYC_PORTAL_CHECK_LABELS[t]}</span>
              <select
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={portal[t]?.result ?? ""}
                onChange={(e) => setPortal({ ...portal, [t]: { result: e.target.value, note: portal[t]?.note ?? "" } })}
              >
                <option value="">Not checked</option>
                {KYC_PORTAL_CHECK_RESULTS.map((r) => (
                  <option key={r} value={r}>{KYC_PORTAL_CHECK_RESULT_LABELS[r]}</option>
                ))}
              </select>
              <Input
                placeholder="What the portal showed"
                value={portal[t]?.note ?? ""}
                onChange={(e) => setPortal({ ...portal, [t]: { result: portal[t]?.result ?? "", note: e.target.value } })}
              />
            </div>
          ))}
          <Button size="sm" disabled={busy} onClick={runChecks}>
            {busy && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
            {step === "not_started" ? "Run checks" : "Re-run checks"}
          </Button>
          {step === "awaiting_signoff" && (
            <p className="text-xs text-muted-foreground">Re-running replaces the flags and clears any sign-off.</p>
          )}
        </div>
      )}

      {step === "awaiting_signoff" && state.can_sign_off && (
        <div className="space-y-3 border-t pt-3">
          {warnings.map((w) => (
            <div key={w.code} className="space-y-1">
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={!!ackOn[w.code]}
                  onChange={(e) => setAckOn({ ...ackOn, [w.code]: e.target.checked })}
                />
                <span>I have reviewed: {w.message}</span>
              </label>
              {ackOn[w.code] && (
                <Textarea
                  rows={2}
                  placeholder={`Reason (at least ${KYC_ACK_REASON_MIN_LENGTH} characters)`}
                  value={ackReason[w.code] ?? ""}
                  onChange={(e) => setAckReason({ ...ackReason, [w.code]: e.target.value })}
                />
              )}
            </div>
          ))}
          <Button
            size="sm"
            disabled={busy || !answered}
            onClick={() =>
              void post("sign-off", { acks: warnings.map((w) => ({ code: w.code, reason: ackReason[w.code] ?? "" })) }, "KYC signed off")
            }
          >
            Sign off KYC
          </Button>
        </div>
      )}
    </div>
  );
}

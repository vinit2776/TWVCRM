"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import {
  ENTITY_TYPES,
  ENTITY_TYPE_LABELS,
  VO_TERM_DOCUMENTS,
  VO_TERM_DOCUMENT_LABELS,
  VO_TERM_PURPOSES,
  VO_TERM_PURPOSE_LABELS,
} from "@/lib/constants";
import { assembleTerms, isApproved, type VoClauseVersion } from "@/lib/vo-terms";
import { formatDate } from "@/lib/utils";

interface VersionRow {
  id: string;
  clause_id: string;
  version: number;
  body: string;
  documents: string[];
  purposes: string[];
  company_types: string[];
  min_term_months: number | null;
  is_current: boolean;
  reason: string | null;
  approved_at: string | null;
  created_at: string;
}

interface ClauseRow {
  id: string;
  code: string;
  title: string;
  current: VersionRow | null;
}

const TERM_OPTIONS = [6, 11, 12, 24, 36, 48];

async function readError(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

function ApprovalBadge({ version }: { version: Pick<VersionRow, "approved_at"> }) {
  return isApproved(version) ? (
    <Badge variant="outline" className="border-green-300 text-green-700">Approved</Badge>
  ) : (
    <Badge variant="outline" className="border-amber-300 text-amber-700">Draft, pending legal review</Badge>
  );
}

function CheckGroup({
  label, options, labels, value, onChange, disabled,
}: {
  label: string;
  options: readonly string[];
  labels: Record<string, string>;
  value: string[];
  onChange: (v: string[]) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5">
        {options.map((o) => (
          <label key={o} className="flex items-center gap-1.5 text-sm">
            <Checkbox checked={value.includes(o)} disabled={disabled} onCheckedChange={() => onChange(toggle(value, o))} />
            {labels[o] ?? o}
          </label>
        ))}
      </div>
    </div>
  );
}

export default function TermsLibraryPage() {
  const [role, setRole] = useState<string | null>(null);
  const [clauses, setClauses] = useState<ClauseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notSetUp, setNotSetUp] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [history, setHistory] = useState<VersionRow[]>([]);

  const [body, setBody] = useState("");
  const [documents, setDocuments] = useState<string[]>([]);
  const [purposes, setPurposes] = useState<string[]>([]);
  const [companyTypes, setCompanyTypes] = useState<string[]>([]);
  const [minTerm, setMinTerm] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const [pvDocument, setPvDocument] = useState<string>("proposal");
  const [pvPurpose, setPvPurpose] = useState<string>("gst_new");
  const [pvCompany, setPvCompany] = useState<string>("pvt_ltd");
  const [pvTerm, setPvTerm] = useState<string>("12");
  const [pvFeeRule, setPvFeeRule] = useState("");

  const isAdmin = role === "admin";
  const current = clauses.find((c) => c.code === selected)?.current ?? null;

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/vo-terms", { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load the terms library"));
      const json = (await res.json()) as { data: ClauseRow[]; notSetUp?: boolean };
      setNotSetUp(!!json.notSetUp);
      setClauses(json.data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the terms library");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (code: string) => {
    try {
      const res = await fetch(`/api/admin/vo-terms?history=${encodeURIComponent(code)}`, { cache: "no-store" });
      if (!res.ok) throw new Error(await readError(res, "Could not load the version history"));
      setHistory(((await res.json()) as { data: VersionRow[] }).data);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not load the version history");
    }
  }, []);

  useEffect(() => {
    void load();
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((me: { role?: string } | null) => setRole(me?.role ?? null))
      .catch(() => setRole(null));
  }, [load]);

  useEffect(() => {
    if (!selected) return;
    void loadHistory(selected);
  }, [selected, loadHistory, clauses]);

  const select = (c: ClauseRow) => {
    setSelected(c.code);
    setBody(c.current?.body ?? "");
    setDocuments(c.current?.documents ?? []);
    setPurposes(c.current?.purposes ?? []);
    setCompanyTypes(c.current?.company_types ?? []);
    setMinTerm(c.current?.min_term_months ? String(c.current.min_term_months) : "");
    setReason("");
  };

  const save = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await fetch("/api/admin/vo-terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "new_version",
          code: selected,
          body,
          documents,
          purposes,
          company_types: companyTypes,
          min_term_months: minTerm.trim() ? Number(minTerm) : null,
          reason,
        }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not save the new version"));
      toast.success("New version saved. It needs approval before it counts as reviewed.");
      setReason("");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save the new version");
    } finally {
      setSaving(false);
    }
  };

  const approve = async (versionId: string) => {
    try {
      const res = await fetch("/api/admin/vo-terms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "approve", version_id: versionId }),
      });
      if (!res.ok) throw new Error(await readError(res, "Could not approve this version"));
      toast.success("Version approved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not approve this version");
    }
  };

  const preview = useMemo(() => {
    const versions: VoClauseVersion[] = clauses.flatMap((c) =>
      c.current ? [{ ...c.current, code: c.code, title: c.title }] : [],
    );
    return assembleTerms({
      clauses: versions,
      document: pvDocument,
      purpose: pvPurpose,
      companyType: pvCompany,
      termMonths: Number(pvTerm),
      values: { fee_rule: pvFeeRule },
    });
  }, [clauses, pvDocument, pvPurpose, pvCompany, pvTerm, pvFeeRule]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading terms library
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <PageBreadcrumb resetTo={{ label: "Terms library" }} />
      <div className="flex items-start gap-3">
        <ScrollText className="mt-1 h-6 w-6 text-muted-foreground" />
        <div>
          <h1 className="text-2xl font-semibold">Virtual Office terms library</h1>
          <p className="text-sm text-muted-foreground">
            Versioned clauses for proposals, agreements and renewal notices. Seed wording is sample text until legal approves it.
            {!isAdmin && " You can read this page; only an admin can edit."}
          </p>
        </div>
      </div>

      {notSetUp ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            The terms library is not set up yet. It will appear here once the database update has been applied.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-base">Clauses</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                {clauses.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => select(c)}
                    className={`w-full rounded-md border p-3 text-left text-sm transition-colors hover:bg-muted/50 ${selected === c.code ? "border-primary bg-muted/50" : ""}`}
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-medium">{c.code}</span>
                      <span className="font-medium">{c.title}</span>
                      {c.current && <Badge variant="secondary">v{c.current.version}</Badge>}
                      {c.current && <ApprovalBadge version={c.current} />}
                    </div>
                    {c.current && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {c.current.documents.map((d) => (
                          <Badge key={d} variant="outline">{VO_TERM_DOCUMENT_LABELS[d] ?? d}</Badge>
                        ))}
                        {c.current.purposes.length === VO_TERM_PURPOSES.length ? (
                          <Badge variant="outline">Both purposes</Badge>
                        ) : (
                          c.current.purposes.map((p) => (
                            <Badge key={p} variant="outline">{VO_TERM_PURPOSE_LABELS[p] ?? p}</Badge>
                          ))
                        )}
                        {c.current.company_types.length < ENTITY_TYPES.length && (
                          <Badge variant="outline">{c.current.company_types.map((t) => ENTITY_TYPE_LABELS[t] ?? t).join(", ")}</Badge>
                        )}
                        {c.current.min_term_months && <Badge variant="outline">{c.current.min_term_months}+ months</Badge>}
                      </div>
                    )}
                  </button>
                ))}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{selected ? `Edit ${selected}` : "Select a clause"}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!selected ? (
                  <p className="text-sm text-muted-foreground">Pick a clause on the left to see its wording and history.</p>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <Label htmlFor="vo-body">Wording</Label>
                      <Textarea id="vo-body" rows={4} value={body} disabled={!isAdmin} onChange={(e) => setBody(e.target.value)} />
                      <p className="text-xs text-muted-foreground">Placeholders: {"{term}"} (months) and {"{fee_rule}"}.</p>
                    </div>
                    <CheckGroup label="Documents" options={VO_TERM_DOCUMENTS} labels={VO_TERM_DOCUMENT_LABELS} value={documents} onChange={setDocuments} disabled={!isAdmin} />
                    <CheckGroup label="Purposes" options={VO_TERM_PURPOSES} labels={VO_TERM_PURPOSE_LABELS} value={purposes} onChange={setPurposes} disabled={!isAdmin} />
                    <CheckGroup label="Company types" options={ENTITY_TYPES} labels={ENTITY_TYPE_LABELS} value={companyTypes} onChange={setCompanyTypes} disabled={!isAdmin} />
                    <div className="space-y-1.5">
                      <Label htmlFor="vo-min-term">Minimum term (months, blank for any)</Label>
                      <Input id="vo-min-term" type="number" min={1} className="w-32" value={minTerm} disabled={!isAdmin} onChange={(e) => setMinTerm(e.target.value)} />
                    </div>
                    {isAdmin && (
                      <div className="space-y-2 border-t pt-4">
                        <Label htmlFor="vo-reason">Reason for the change</Label>
                        <Input id="vo-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this changing?" />
                        <div className="flex flex-wrap gap-2">
                          <Button onClick={save} disabled={saving || !reason.trim() || !body.trim() || !documents.length || !purposes.length || !companyTypes.length}>
                            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save as new version
                          </Button>
                          {current && !isApproved(current) && (
                            <Button variant="outline" onClick={() => approve(current.id)}>Approve v{current.version}</Button>
                          )}
                        </div>
                      </div>
                    )}

                    <div className="space-y-2 border-t pt-4">
                      <h3 className="text-sm font-medium">Version history</h3>
                      {history.map((h) => (
                        <div key={h.id} className="rounded-md border p-3 text-sm">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">v{h.version}</span>
                            {h.is_current && <Badge variant="secondary">Current</Badge>}
                            <ApprovalBadge version={h} />
                            <span className="text-xs text-muted-foreground">{formatDate(h.created_at)}</span>
                          </div>
                          {h.reason && <p className="mt-1 text-xs text-muted-foreground">Reason: {h.reason}</p>}
                          <p className="mt-1">{h.body}</p>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Assembled terms</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <div className="space-y-1.5">
                  <Label>Document</Label>
                  <Select value={pvDocument} onValueChange={setPvDocument}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{VO_TERM_DOCUMENTS.map((d) => <SelectItem key={d} value={d}>{VO_TERM_DOCUMENT_LABELS[d]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Purpose</Label>
                  <Select value={pvPurpose} onValueChange={setPvPurpose}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{VO_TERM_PURPOSES.map((p) => <SelectItem key={p} value={p}>{VO_TERM_PURPOSE_LABELS[p]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Company type</Label>
                  <Select value={pvCompany} onValueChange={setPvCompany}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{ENTITY_TYPES.map((t) => <SelectItem key={t} value={t}>{ENTITY_TYPE_LABELS[t]}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Term (months)</Label>
                  <Select value={pvTerm} onValueChange={setPvTerm}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{TERM_OPTIONS.map((t) => <SelectItem key={t} value={String(t)}>{t}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="pv-fee">Fee rule (renewal)</Label>
                  <Input id="pv-fee" value={pvFeeRule} onChange={(e) => setPvFeeRule(e.target.value)} placeholder="e.g. the current fee" />
                </div>
              </div>

              {preview.errors.length > 0 && (
                <ul className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700">
                  {preview.errors.map((e) => <li key={e}>{e}</li>)}
                </ul>
              )}
              <ol className="space-y-2 text-sm">
                {preview.lines.map((l) => (
                  <li key={l.code} className="flex gap-3">
                    <span className="font-mono text-xs text-muted-foreground">{l.code} v{l.version}</span>
                    <span>{l.text}</span>
                  </li>
                ))}
              </ol>
              {preview.lines.length === 0 && <p className="text-sm text-muted-foreground">No clauses apply to this selection.</p>}
              <p className="text-xs text-muted-foreground">{preview.excluded} other clause(s) do not apply to this selection.</p>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

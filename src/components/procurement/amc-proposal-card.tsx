"use client";

import { useMemo, useRef, useState } from "react";
import { FileUp, Loader2, Plus, ScanSearch } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EXTRACTION_MEDIA_TYPES } from "@/lib/procurement/proposal-extraction";
import type { ExtractedAmcProposal } from "@/lib/procurement/proposal-extraction";
import { requestProposalExtraction } from "@/lib/procurement/proposal-extract-client";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { FacilityAssetFormDialog } from "@/components/facility/asset-form-dialog";
import type { FacilityAsset } from "@/types";
import { assetDetail, describeUnitMismatch, findPossibleDuplicates, normaliseSerial, rankAssetsForUnit, type DuplicateCandidate } from "@/lib/asset-duplicates";
import { useAmcOverlap } from "@/lib/procurement/use-amc-overlap";
import { AssetMismatchNote, AssetOverlapNote } from "@/components/procurement/asset-warnings";
import { planAmcPrefill, suggestAssetForUnit, UNIT_SKIPPED, type PrefillAnswers, type PrefillCurrent, type PrefillPlan } from "@/lib/procurement/amc-prefill";

const MAX_BYTES = 10 * 1024 * 1024;

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ok"; extracted: ExtractedAmcProposal }
  | { status: "applied"; count: number };

export interface CardAsset {
  id: string;
  name: string;
  asset_code?: string | null;
  serial_number?: string | null;
  model?: string | null;
  notes?: string | null;
  category?: { name?: string | null; slug?: string | null } | null;
}

interface Props {
  current: PrefillCurrent;
  /** Active assets the units in a multi-unit proposal are matched to. */
  assets: CardAsset[];
  /** The request's location, offered as the default when a missing asset is created from here. */
  defaultLocationId?: string;
  /** Called with an asset created from a unit row, so the wizard can offer it on the Cost step too. */
  onAssetCreated: (asset: FacilityAsset) => void;
  /** Called when the user confirms. The wizard fills its fields and keeps the file as the proposal. */
  onApply: (plan: PrefillPlan, file: File, extracted: ExtractedAmcProposal, answers: PrefillAnswers) => number;
}

/**
 * Optional first step: read the vendor's proposal and fill in what it says. Nothing changes
 * until the user presses the button, and the next steps still show every value for checking.
 */
export function AmcProposalCard({ current, assets, defaultLocationId, onAssetCreated, onApply }: Props) {
  const [state, setState] = useState<State>({ status: "idle" });
  const [file, setFile] = useState<File | null>(null);
  const [answers, setAnswers] = useState<PrefillAnswers>({});
  // One entry per unit in the proposal: an asset id, UNIT_SKIPPED, or "" while undecided.
  const [unitAssets, setUnitAssets] = useState<string[]>([]);
  // The unit (by row) a new asset is being created for; null when the dialog is closed.
  const [creatingFor, setCreatingFor] = useState<number | null>(null);
  // Shown under a unit before a new asset is created, when it may already be registered.
  const [dupPrompt, setDupPrompt] = useState<{ row: number; kind: "serial" | "model"; matches: DuplicateCandidate[] } | null>(null);
  const [checkingRow, setCheckingRow] = useState<number | null>(null);
  const seq = useRef(0);
  const input = useRef<HTMLInputElement>(null);

  const extracted = state.status === "ok" ? state.extracted : null;
  const plan = useMemo(() => (extracted ? planAmcPrefill(extracted, current, answers, unitAssets) : null), [extracted, current, answers, unitAssets]);
  // Other live AMCs already covering the chosen assets in the proposal's dates (advisory).
  const overlaps = useAmcOverlap(unitAssets.filter((a) => a && a !== UNIT_SKIPPED), extracted?.startDate, extracted?.endDate);
  // Best matches first, each with enough detail (model, serial, capacity) to tell similar assets apart.
  const optionsFor = (u: { serial: string | null; model: string | null; capacity: string | null }) => [
    { value: UNIT_SKIPPED, label: "Not ours / leave out" },
    ...rankAssetsForUnit(u, assets).map(({ asset, score }) => ({
      value: asset.id,
      label: `${asset.name}${asset.asset_code ? ` (${asset.asset_code})` : ""}`,
      detail: assetDetail(asset) || undefined,
      badge: score >= 50 ? { text: "Likely match", className: "bg-green-100 text-green-800" } : undefined,
    })),
  ];


  const pick = (f: File | null) => {
    if (!f) return;
    if (f.size > MAX_BYTES) { toast.error("That file is over 10 MB. Try a smaller copy."); return; }
    if (!(EXTRACTION_MEDIA_TYPES as readonly string[]).includes(f.type)) { toast.error("Upload a PDF, JPG, PNG or WebP of the proposal."); return; }
    const mine = ++seq.current;
    setFile(f);
    setAnswers({});
    setUnitAssets([]);
    setState({ status: "loading" });
    requestProposalExtraction(f).then((x) => {
      if (mine !== seq.current) return;
      if (x) setUnitAssets(x.equipment.length > 1 ? x.equipment.map((e) => suggestAssetForUnit(e, assets)) : []);
      setState(x ? { status: "ok", extracted: x } : { status: "unavailable" });
    });
  };

  const newAssetDefaults = useMemo(() => {
    const u = creatingFor !== null ? extracted?.equipment[creatingFor] : null;
    if (!u) return undefined;
    return {
      name: [u.description, u.capacity].filter(Boolean).join(" ").slice(0, 120),
      make: extracted?.vendorName ?? "",
      model: u.model ?? "",
      serial_number: u.serial ?? "",
      vendor: extracted?.vendorName ?? "",
      notes: u.capacity ? `Capacity ${u.capacity}. Added from the vendor's AMC proposal.` : "Added from the vendor's AMC proposal.",
    };
  }, [creatingFor, extracted]);

  const chooseForRow = (row: number, assetId: string) => {
    if (!extracted) return;
    setUnitAssets((prev) => extracted.equipment.map((_, j) => (j === row ? assetId : prev[j] ?? "")));
    setDupPrompt(null);
  };

  /** Before opening the new-asset form, look for an asset that may already be this unit. */
  const requestNewAsset = async (row: number) => {
    const u = extracted?.equipment[row];
    if (!u) return;
    setCheckingRow(row);
    try {
      // Assets matched to another unit cannot be this one.
      const taken = new Set(unitAssets.filter((a, j) => j !== row && a && a !== UNIT_SKIPPED));
      // The picker only lists active assets; a search also finds retired ones with the same serial.
      let pool: DuplicateCandidate[] = assets;
      if (normaliseSerial(u.serial)) {
        const res = await fetch(`/api/facility/assets?search=${encodeURIComponent(u.serial!.trim())}`).then((r) => r.json()).catch(() => null);
        if (Array.isArray(res?.data)) pool = [...assets, ...(res.data as DuplicateCandidate[]).filter((a) => !assets.some((x) => x.id === a.id))];
      }
      const { sameSerial, sameModel } = findPossibleDuplicates(u, pool, taken);
      if (sameSerial.length > 0) setDupPrompt({ row, kind: "serial", matches: sameSerial });
      else if (sameModel.length > 0) setDupPrompt({ row, kind: "model", matches: sameModel });
      else setCreatingFor(row);
    } finally {
      setCheckingRow(null);
    }
  };

  const reset = () => {
    seq.current++;
    setFile(null);
    setAnswers({});
    setUnitAssets([]);
    setState({ status: "idle" });
    if (input.current) input.current.value = "";
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2"><ScanSearch className="h-4 w-4" /> Have the vendor&apos;s proposal?</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {state.status === "applied" ? (
          <div className="space-y-2">
            <p className="text-sm text-green-800 bg-green-50 border border-green-200 rounded px-3 py-2">
              Filled in {state.count} detail{state.count === 1 ? "" : "s"} from the proposal, and attached it. Check each step as you go.
            </p>
            <Button variant="ghost" size="sm" onClick={reset}>Use a different proposal</Button>
          </div>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Upload it and we&apos;ll read the dates, billing, visits and cost for you. You check everything before it is used. No proposal? Skip this and type it in on the next steps.
            </p>
            <input
              ref={input}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/*"
              className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
              onChange={(e) => pick(e.target.files?.[0] ?? null)}
            />
          </>
        )}

        {state.status === "loading" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Reading the proposal… this takes about 15 seconds.</p>
        )}

        {state.status === "unavailable" && (
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">
            We couldn&apos;t read that file. You can still type everything in on the next steps, and attach the proposal in step 5.
          </p>
        )}

        {plan && file && extracted && (
          <div className="space-y-3">
            {extracted.confidence === "low" && (
              <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded px-3 py-2">It was hard to read. Double-check every figure.</p>
            )}
            <dl className="rounded-lg border divide-y text-sm">
              {plan.found.length === 0 && <div className="px-3 py-2 text-muted-foreground">Nothing we could use was found.</div>}
              {plan.found.map((f) => (
                <div key={f.label} className="flex justify-between gap-4 px-3 py-2">
                  <dt className="text-muted-foreground shrink-0">{f.label}</dt>
                  <dd className="font-medium text-right">{f.value}</dd>
                </div>
              ))}
            </dl>
            {extracted.equipment.length > 1 && (
              <div className="rounded-lg border">
                <div className="px-3 py-2 border-b bg-muted/40">
                  <p className="text-sm font-medium">{extracted.equipment.length} units are listed. Which asset is each one?</p>
                  <p className="text-xs text-muted-foreground">Units matched to the same asset are billed together. Choose &quot;Not ours&quot; for any unit this contract should not cover.</p>
                </div>
                <ul className="divide-y">
                  {extracted.equipment.map((u, i) => (
                    <li key={i} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[1fr_16rem] sm:items-center">
                      <div className="text-sm min-w-0">
                        <p className="font-medium">{i + 1}. {[u.capacity, u.model ?? u.description].filter(Boolean).join(" · ")}</p>
                        <p className="text-xs text-muted-foreground break-words">
                          {u.serial ? `Serial ${u.serial}` : "No serial number"} · {u.rate ? `₹${u.rate.toLocaleString("en-IN")} for the year` : "No cost listed"}
                        </p>
                      </div>
                      <div className="space-y-1">
                        <SearchableSelect
                          options={optionsFor(u)}
                          value={unitAssets[i] ?? ""}
                          onValueChange={(v) => chooseForRow(i, v)}
                          placeholder="Choose the asset…"
                          emptyMessage="No active assets found"
                        />
                        <button type="button" disabled={checkingRow === i} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline disabled:opacity-60" onClick={() => void requestNewAsset(i)}>
                          {checkingRow === i ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} Not in the list? Add it as a new asset
                        </button>
                      </div>
                      {unitAssets[i] && unitAssets[i] !== UNIT_SKIPPED && (() => {
                        const chosenAsset = assets.find((a) => a.id === unitAssets[i]);
                        const reasons = chosenAsset ? describeUnitMismatch(u, chosenAsset) : [];
                        const sharers = extracted.equipment.map((_, j) => j).filter((j) => unitAssets[j] === unitAssets[i]);
                        const sharedTotal = sharers.reduce((sum, j) => sum + (extracted.equipment[j].rate ?? 0), 0);
                        if (reasons.length === 0 && !overlaps[unitAssets[i]]?.length && sharers.length < 2) return null;
                        return (
                          <div className="sm:col-span-2 space-y-2">
                            {sharers.length > 1 && (
                              <p className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                                Units {sharers.map((j) => j + 1).join(", ")} are on this one asset, so they will be billed together as a single line{sharedTotal > 0 ? `: ₹${sharedTotal.toLocaleString("en-IN")} for the year` : ""}.
                              </p>
                            )}
                            <AssetMismatchNote reasons={reasons} />
                            <AssetOverlapNote conflicts={overlaps[unitAssets[i]]} />
                          </div>
                        );
                      })()}
                      {dupPrompt?.row === i && (
                        <div className="sm:col-span-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 space-y-2">
                          <p className="text-sm font-medium text-amber-900">
                            {dupPrompt.kind === "serial"
                              ? "An asset with this serial number is already registered. This is probably the same unit, and adding it again would create a duplicate."
                              : "Assets of the same model are already registered and not matched to another unit. Is this unit one of them?"}
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {dupPrompt.matches.map((m) => (
                              <Button key={m.id} size="sm" variant="outline" onClick={() => chooseForRow(i, m.id)}>
                                Use {m.name}{m.asset_code ? ` (${m.asset_code})` : ""}{m.serial_number ? ` · ${m.serial_number}` : " · no serial"}
                              </Button>
                            ))}
                            <Button size="sm" variant="ghost" onClick={() => { setDupPrompt(null); setCreatingFor(i); }}>
                              {dupPrompt.kind === "serial" ? "Add it anyway" : "No, it is a different unit. Add a new asset"}
                            </Button>
                          </div>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
                {assets.length === 0 && <p className="px-3 py-2 text-xs text-amber-800 bg-amber-50 border-t border-amber-200">No active assets were found. Use &quot;Add it as a new asset&quot; on each unit.</p>}
              </div>
            )}
            {plan.questions.map((q) => (
              <div key={q.id} className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 space-y-2">
                <p className="text-sm font-medium text-amber-900">{q.prompt}</p>
                <div className="flex flex-wrap gap-2">
                  {q.options.map((o) => (
                    <Button key={o.value} size="sm" variant={answers[q.id] === o.value ? "default" : "outline"} onClick={() => setAnswers((a) => ({ ...a, [q.id]: o.value }))}>{o.label}</Button>
                  ))}
                </div>
              </div>
            ))}
            {plan.notes.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground space-y-0.5">
                {plan.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={plan.questions.length > 0 || plan.unitsToDecide > 0 || plan.found.length === 0}
                onClick={() => {
                  const count = onApply(plan, file, extracted, answers);
                  setState({ status: "applied", count });
                }}
              >
                <FileUp className="h-4 w-4 mr-1" /> Fill in the steps for me
              </Button>
              <Button variant="outline" onClick={reset}>Don&apos;t use it</Button>
            </div>
            {(plan.questions.length > 0 || plan.unitsToDecide > 0) && (
              <p className="text-xs text-muted-foreground">
                {plan.unitsToDecide > 0 ? `Choose an asset for ${plan.unitsToDecide} more unit${plan.unitsToDecide === 1 ? "" : "s"}` : ""}
                {plan.unitsToDecide > 0 && plan.questions.length > 0 ? " and answer" : plan.questions.length > 0 ? "Answer" : ""}
                {plan.questions.length > 0 ? ` the question${plan.questions.length === 1 ? "" : "s"} above` : ""} to continue.
              </p>
            )}
          </div>
        )}
      </CardContent>
      <FacilityAssetFormDialog
        open={creatingFor !== null}
        onOpenChange={(o) => { if (!o) setCreatingFor(null); }}
        defaultLocationId={defaultLocationId}
        initialValues={newAssetDefaults}
        onSuccess={(a) => {
          const row = creatingFor;
          onAssetCreated(a);
          if (row !== null && extracted) setUnitAssets((prev) => extracted.equipment.map((_, j) => (j === row ? a.id : prev[j] ?? "")));
          setCreatingFor(null);
        }}
      />
    </Card>
  );
}

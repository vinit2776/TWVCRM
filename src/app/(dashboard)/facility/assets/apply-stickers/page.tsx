"use client";

import { Suspense, useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CheckCircle2, XCircle, ScanLine, MapPin, Tag, ChevronRight, SkipForward } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { QRScannerDialog } from "@/components/facility/qr-scanner-dialog";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import type { FacilityAsset } from "@/types";

type StepStatus = "pending" | "confirmed" | "skipped";

interface AssetStep {
  asset: FacilityAsset;
  status: StepStatus;
  scannedCode?: string;
}

export default function ApplyStickersPage() {
  return (
    <Suspense fallback={<div className="min-h-screen flex items-center justify-center"><p className="text-sm text-muted-foreground">Loading…</p></div>}>
      <ApplyStickersContent />
    </Suspense>
  );
}

function ApplyStickersContent() {
  const searchParams = useSearchParams();
  const rawIds = searchParams.get("ids") ?? "";
  const ids = rawIds.split(",").map((s) => s.trim()).filter(Boolean);

  const [steps, setSteps] = useState<AssetStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [scannerOpen, setScannerOpen] = useState(false);
  const [scanResult, setScanResult] = useState<"correct" | "wrong" | null>(null);
  const [wrongInfo, setWrongInfo] = useState<{ scanned: string; name: string } | null>(null);

  useEffect(() => {
    if (ids.length === 0) { setLoading(false); return; }
    (async () => {
      const fetched = await Promise.all(
        ids.map((id) =>
          fetch(`/api/facility/assets/${id}`).then((r) => r.json()).then((j) => j.data as FacilityAsset | null)
        )
      );
      const valid = fetched.filter(Boolean) as FacilityAsset[];
      valid.sort((a, b) => {
        const loc = (a.location?.name ?? "").localeCompare(b.location?.name ?? "");
        if (loc !== 0) return loc;
        const fl = (a.floor?.name ?? "").localeCompare(b.floor?.name ?? "");
        if (fl !== 0) return fl;
        return a.asset_code.localeCompare(b.asset_code);
      });
      setSteps(valid.map((a) => ({ asset: a, status: "pending" })));
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawIds]);

  const current = steps[currentIdx];
  const done = steps.length > 0 && currentIdx >= steps.length;
  const confirmed = steps.filter((s) => s.status === "confirmed").length;
  const skipped = steps.filter((s) => s.status === "skipped").length;

  const handleScanned = useCallback((scannedAsset: { asset_code: string; name: string }) => {
    setScannerOpen(false);
    if (!current) return;
    const expected = current.asset.asset_code;
    const got = scannedAsset.asset_code;

    if (got === expected) {
      setScanResult("correct");
      setSteps((prev) => {
        const next = [...prev];
        next[currentIdx] = { ...next[currentIdx], status: "confirmed", scannedCode: got };
        return next;
      });
      setTimeout(() => {
        setScanResult(null);
        setCurrentIdx((i) => i + 1);
      }, 1200);
    } else {
      setScanResult("wrong");
      setWrongInfo({ scanned: got, name: scannedAsset.name });
    }
  }, [current, currentIdx]);

  const handleSkip = () => {
    setScanResult(null);
    setWrongInfo(null);
    setSteps((prev) => {
      const next = [...prev];
      next[currentIdx] = { ...next[currentIdx], status: "skipped" };
      return next;
    });
    setCurrentIdx((i) => i + 1);
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <PageBreadcrumb resetTo={{ label: "Apply Stickers" }} />
        <p className="text-sm text-muted-foreground">Loading assets…</p>
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 p-6">
        <PageBreadcrumb resetTo={{ label: "Apply Stickers" }} />
        <p className="text-sm text-muted-foreground">No assets to apply stickers for.</p>
        <Link href="/facility/assets"><Button variant="outline" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button></Link>
      </div>
    );
  }

  /* ── Completion screen ── */
  if (done) {
    return (
      <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center gap-6 p-6">
        <PageBreadcrumb resetTo={{ label: "Apply Stickers" }} />
        <CheckCircle2 className="h-16 w-16 text-emerald-500" />
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold">All done!</h1>
          <p className="text-sm text-muted-foreground">
            {confirmed} confirmed · {skipped} skipped
          </p>
        </div>

        {/* Summary */}
        <div className="w-full max-w-sm space-y-2">
          {steps.map((s, i) => (
            <div key={s.asset.id} className={cn(
              "flex items-center gap-3 px-4 py-2.5 rounded-xl text-sm",
              s.status === "confirmed" ? "bg-emerald-50 text-emerald-800" : "bg-amber-50 text-amber-700"
            )}>
              {s.status === "confirmed"
                ? <CheckCircle2 className="h-4 w-4 shrink-0" />
                : <SkipForward className="h-4 w-4 shrink-0" />}
              <span className="font-mono text-xs font-semibold">#{i + 1}</span>
              <span className="flex-1 truncate">{s.asset.name}</span>
              <span className="text-xs opacity-60">{s.status}</span>
            </div>
          ))}
        </div>

        <Link href="/facility/assets">
          <Button><ArrowLeft className="h-4 w-4 mr-1.5" /> Back to assets</Button>
        </Link>
      </div>
    );
  }

  const locationLine = [current.asset.location?.name, current.asset.floor?.name].filter(Boolean).join(" · ");
  const progress = (currentIdx / steps.length) * 100;

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <PageBreadcrumb resetTo={{ label: "Apply Stickers" }} />
      {/* Header */}
      <div className="bg-white border-b px-4 py-3 flex items-center gap-3">
        <Link href="/facility/assets">
          <Button variant="ghost" size="icon" className="h-8 w-8">
            <ArrowLeft className="h-4 w-4" />
          </Button>
        </Link>
        <div className="flex-1">
          <p className="text-xs text-muted-foreground">Step {currentIdx + 1} of {steps.length}</p>
          <div className="h-1.5 bg-gray-100 rounded-full mt-1 overflow-hidden">
            <div
              className="h-full bg-emerald-500 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
        <span className="text-xs text-muted-foreground font-medium">{Math.round(progress)}%</span>
      </div>

      {/* Upcoming strip */}
      {currentIdx + 1 < steps.length && (
        <div className="bg-white border-b px-4 py-2 flex items-center gap-2 text-xs text-muted-foreground">
          <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          <span>Next: </span>
          <span className="font-mono font-semibold">{steps[currentIdx + 1].asset.asset_code}</span>
          <span className="truncate">{steps[currentIdx + 1].asset.name}</span>
        </div>
      )}

      {/* Main card */}
      <div className="flex-1 flex flex-col items-center justify-center p-5">
        <div className="w-full max-w-sm space-y-4">

          {/* Label number badge */}
          <div className="flex items-center gap-2">
            <span className="text-4xl font-black text-gray-200">#{currentIdx + 1}</span>
            <span className="text-xs text-muted-foreground">on your printed sheet</span>
          </div>

          {/* Asset card */}
          <div className={cn(
            "rounded-2xl border-2 bg-white p-5 space-y-3 transition-all",
            scanResult === "correct" && "border-emerald-400 bg-emerald-50",
            scanResult === "wrong" && "border-red-400 bg-red-50",
            scanResult === null && "border-gray-200",
          )}>
            <div>
              <span className="font-mono text-xs font-bold tracking-widest text-muted-foreground">{current.asset.asset_code}</span>
              <h2 className="text-xl font-bold text-gray-900 mt-0.5">{current.asset.name}</h2>
            </div>

            <div className="space-y-1 text-sm text-gray-500">
              {locationLine && (
                <div className="flex items-center gap-1.5">
                  <MapPin className="h-3.5 w-3.5 shrink-0" />
                  {locationLine}
                </div>
              )}
              {current.asset.category?.name && (
                <div className="flex items-center gap-1.5">
                  <Tag className="h-3.5 w-3.5 shrink-0" />
                  {current.asset.category.name}
                </div>
              )}
              {(current.asset.make || current.asset.model) && (
                <div className="text-xs text-muted-foreground mt-1">
                  {[current.asset.make, current.asset.model].filter(Boolean).join(" ")}
                </div>
              )}
            </div>

            {/* Scan result feedback */}
            {scanResult === "correct" && (
              <div className="flex items-center gap-2 text-emerald-700 font-semibold">
                <CheckCircle2 className="h-5 w-5" />
                Correct! Moving to next…
              </div>
            )}
            {scanResult === "wrong" && wrongInfo && (
              <div className="space-y-2">
                <div className="flex items-start gap-2 text-red-700">
                  <XCircle className="h-5 w-5 shrink-0 mt-0.5" />
                  <div>
                    <div className="font-semibold">Wrong sticker!</div>
                    <div className="text-sm">
                      You scanned <span className="font-mono font-bold">{wrongInfo.scanned}</span>{" "}
                      ({wrongInfo.name}), but this spot needs{" "}
                      <span className="font-mono font-bold">{current.asset.asset_code}</span>.
                    </div>
                    <div className="text-xs mt-1 text-red-600">Peel it off and find the correct label.</div>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full border-red-200 text-red-700 hover:bg-red-50"
                  onClick={() => { setScanResult(null); setWrongInfo(null); }}
                >
                  Try scanning again
                </Button>
              </div>
            )}
          </div>

          {/* Actions */}
          {scanResult !== "correct" && (
            <div className="space-y-2">
              <Button
                className="w-full h-12 text-base"
                onClick={() => { setScanResult(null); setWrongInfo(null); setScannerOpen(true); }}
              >
                <ScanLine className="h-5 w-5 mr-2" />
                Scan QR to confirm
              </Button>
              <Button
                variant="ghost"
                className="w-full text-muted-foreground"
                onClick={handleSkip}
              >
                <SkipForward className="h-4 w-4 mr-1.5" />
                Skip this one
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* Sidebar-style progress dots */}
      <div className="bg-white border-t px-4 py-3 flex items-center gap-1.5 overflow-x-auto">
        {steps.map((s, i) => (
          <div
            key={s.asset.id}
            title={s.asset.asset_code}
            className={cn(
              "h-2 rounded-full shrink-0 transition-all",
              i === currentIdx ? "w-5 bg-gray-700" :
              s.status === "confirmed" ? "w-2 bg-emerald-400" :
              s.status === "skipped" ? "w-2 bg-amber-400" :
              "w-2 bg-gray-200"
            )}
          />
        ))}
      </div>

      <QRScannerDialog
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onAssetScanned={handleScanned}
      />
    </div>
  );
}

"use client";

import { use, useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import Link from "next/link";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PageBreadcrumb } from "@/components/page-breadcrumb";
import type { FacilityAsset } from "@/types";

type Layout = "avery" | "9up" | "single";

const GRID_SIZE: Record<Layout, number> = { avery: 21, "9up": 8, single: 1 };

export default function AssetQRPrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [asset, setAsset] = useState<FacilityAsset | null>(null);
  const [layout, setLayout] = useState<Layout>("avery");
  const [copies, setCopies] = useState(1);
  const [startFrom, setStartFrom] = useState(1); // 1-indexed label position to start printing
  const [qrDataUrl, setQrDataUrl] = useState("");
  const printAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/facility/assets/${id}`)
      .then((r) => r.json())
      .then((j) => { if (j.data) setAsset(j.data); });
  }, [id]);

  useEffect(() => {
    if (!asset || typeof window === "undefined") return;
    const url = `${window.location.origin}/asset/${asset.asset_code}`;
    QRCode.toDataURL(url, { width: 400, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
      .then(setQrDataUrl);
  }, [asset, id]);

  const handlePrint = () => {
    const area = printAreaRef.current;
    if (!area) return;
    const origin = window.location.origin;
    // Make relative image URLs absolute so they resolve in the isolated window
    const html = area.innerHTML.replace(/src="\/([^"]+)"/g, `src="${origin}/$1"`);
    const pw = window.open("", "_blank", "width=900,height=1200");
    if (!pw) return;
    pw.document.write(
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        *{box-sizing:border-box;margin:0;padding:0;}
        body{background:white;}
        @page{margin:0;size:A4 portrait;}
        @media print{body{print-color-adjust:exact;-webkit-print-color-adjust:exact;}}
      </style></head><body>${html}</body></html>`
    );
    pw.document.close();
    pw.focus();
    pw.addEventListener("afterprint", () => pw.close());
    setTimeout(() => { pw.print(); }, 600);
  };

  if (!asset) return <div className="p-8 text-sm text-muted-foreground">Loading…</div>;

  const locationLine = [asset.location?.name, asset.floor?.name].filter(Boolean).join(" · ");
  const maxLabels = GRID_SIZE[layout];
  // For avery/9up: how many actual labels fit from startFrom position
  const availableSlots = layout === "single" ? 1 : maxLabels - (startFrom - 1);
  const effectiveCopies = layout === "single" ? 1 : Math.min(copies, availableSlots);

  return (
    <>
      <div data-print-hide className="px-4 pt-3">
        <PageBreadcrumb
          current={{ label: "Print" }}
          fallbackParent={{ href: "/facility/assets", label: "Assets" }}
        />
      </div>
      {/* Controls bar */}
      <div data-print-hide className="flex items-center gap-2 px-4 h-14 border-b bg-background flex-wrap">
        <Link href={`/facility/assets/${id}`}>
          <Button variant="ghost" size="sm">
            <ArrowLeft className="h-4 w-4 mr-1" /> Back
          </Button>
        </Link>

        <div className="flex items-center gap-1.5 ml-2">
          {(["avery", "9up", "single"] as Layout[]).map((l) => (
            <button
              key={l}
              onClick={() => { setLayout(l); setCopies(1); setStartFrom(1); }}
              className="px-3 py-1 rounded text-sm transition-colors"
              style={{
                background: layout === l ? "#111" : "#e9e9e9",
                color: layout === l ? "white" : "#444",
                border: "none", cursor: "pointer",
              }}
            >
              {l === "avery" ? "21-up (63.5×38mm)" : l === "9up" ? "8-up (100×72mm)" : "Single large"}
            </button>
          ))}
        </div>

        {layout !== "single" && (
          <>
            <label className="flex items-center gap-1.5 ml-3 text-sm text-muted-foreground">
              Start at:
              <input
                type="number" min={1} max={maxLabels} value={startFrom}
                onChange={(e) => {
                  const v = Math.min(maxLabels, Math.max(1, Number(e.target.value)));
                  setStartFrom(v);
                  setCopies(Math.min(copies, maxLabels - (v - 1)));
                }}
                className="w-14 px-2 py-0.5 rounded border text-sm text-foreground"
              />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-muted-foreground">
              Qty:
              <input
                type="number" min={1} max={availableSlots} value={effectiveCopies}
                onChange={(e) => setCopies(Math.min(availableSlots, Math.max(1, Number(e.target.value))))}
                className="w-14 px-2 py-0.5 rounded border text-sm text-foreground"
              />
              <span className="text-xs text-muted-foreground">/ {availableSlots}</span>
            </label>
          </>
        )}

        <Button size="sm" className="ml-auto" onClick={handlePrint}>
          <Printer className="h-4 w-4 mr-1.5" /> Print
        </Button>
      </div>

      {/* Hint */}
      <div data-print-hide className="text-xs text-muted-foreground px-4 py-2 bg-muted/30 border-b">
        {layout === "avery" && `21 labels per A4 (63.5 × 38 mm). Printing ${effectiveCopies} label(s) starting at position ${startFrom}.${startFrom > 1 ? ` Positions 1–${startFrom - 1} will be left blank for already-used labels.` : ""}`}
        {layout === "9up" && `8-up cut sheet — 2 × 4 (100 × 72 mm). Printing ${effectiveCopies} starting at position ${startFrom}. Cut along dashed lines.`}
        {layout === "single" && "Single large label — good for test-printing before a full sheet."}
      </div>

      {/* ── PRINT AREA ──────────────────────────────────────────────── */}
      <div ref={printAreaRef} style={{ background: layout !== "single" ? "white" : "#f0f0f0", display: "flex", justifyContent: "center", padding: layout !== "single" ? 0 : 24 }}>

        {/* SINGLE LARGE */}
        {layout === "single" && (
          <SingleLabel qr={qrDataUrl} code={asset.asset_code} name={asset.name} location={locationLine} />
        )}

        {/* 8-UP CUT SHEET */}
        {layout === "9up" && (
          <div style={{
            width: "210mm", background: "white",
            display: "grid",
            gridTemplateColumns: "repeat(2, 100mm)",
            gridTemplateRows: "repeat(4, 72mm)",
            padding: "5mm",
            gap: "2mm",
          }}>
            {Array.from({ length: maxLabels }).map((_, i) => {
              const pos = i + 1;
              const isLabel = pos >= startFrom && pos < startFrom + effectiveCopies;
              return (
                <div key={i} style={{ border: "0.5px dashed #bbb", boxSizing: "border-box", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2mm", padding: "2mm" }}>
                  {isLabel ? (
                    <>
                      <img src="/logo.png" alt="The WorkVilla" style={{ width: "28mm", height: "auto" }} />
                      {qrDataUrl && <img src={qrDataUrl} alt="QR code" style={{ width: "32mm", height: "32mm" }} />}
                      <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "8pt", letterSpacing: "0.04em", textAlign: "center" }}>{asset.asset_code}</div>
                      <div style={{ fontSize: "6pt", textAlign: "center", lineHeight: 1.2 }}>{asset.name}</div>
                      {locationLine && <div style={{ fontSize: "5pt", color: "#666", textAlign: "center" }}>{locationLine}</div>}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {/* AVERY / NovaJet 21-up — 3 cols × 7 rows, 63.5 × 38 mm */}
        {layout === "avery" && (
          <div style={{
            width: "210mm", background: "white",
            display: "grid",
            gridTemplateColumns: "63.5mm 63.5mm 63.5mm",
            gridAutoRows: "38.1mm",
            paddingTop: "15.1mm",
            paddingLeft: "4.65mm",
            columnGap: "2.5mm",
            rowGap: "0mm",
          }}>
            {Array.from({ length: maxLabels }).map((_, i) => {
              const pos = i + 1;
              const isLabel = pos >= startFrom && pos < startFrom + effectiveCopies;
              return (
                <div key={i} style={{ boxSizing: "border-box", overflow: "hidden", display: "flex", alignItems: "center", gap: "1.5mm", padding: "1mm 2mm" }}>
                  {isLabel ? (
                    <>
                      {/* Left: QR code */}
                      <div style={{ flexShrink: 0 }}>
                        {qrDataUrl && <img src={qrDataUrl} alt="QR" style={{ width: "22mm", height: "22mm" }} />}
                      </div>
                      {/* Right: logo + text stack */}
                      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, overflow: "hidden" }}>
                        <img src="/logo.png" alt="TWV" style={{ width: "28mm", height: "auto" }} />
                        <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "7pt", letterSpacing: "0.04em" }}>{asset.asset_code}</div>
                        <div style={{ fontSize: "5pt", textAlign: "center", lineHeight: 1.2, maxHeight: "3em", overflow: "hidden" }}>{asset.name}</div>
                        {locationLine && <div style={{ fontSize: "4.5pt", color: "#666", textAlign: "center" }}>{locationLine}</div>}
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function SingleLabel({ qr, code, name, location }: { qr: string; code: string; name: string; location: string }) {
  return (
    <div style={{
      width: "100mm", minHeight: "145mm",
      background: "white", border: "1px solid #ccc",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 6, padding: "6mm",
      boxShadow: "0 2px 12px rgba(0,0,0,0.12)",
    }}>
      <img src="/logo.png" alt="The WorkVilla" style={{ width: "60mm", height: "auto", marginBottom: 4 }} />
      {qr && <img src={qr} alt="QR code" style={{ width: "62mm", height: "62mm" }} />}
      <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "15pt", letterSpacing: "0.08em", marginTop: 2 }}>{code}</div>
      <div style={{ fontSize: "11pt", textAlign: "center", lineHeight: 1.3 }}>{name}</div>
      {location && <div style={{ fontSize: "9pt", color: "#666", textAlign: "center" }}>{location}</div>}
      <div style={{ fontSize: "7.5pt", color: "#999", marginTop: 2 }}>Scan to view details or report an issue</div>
    </div>
  );
}

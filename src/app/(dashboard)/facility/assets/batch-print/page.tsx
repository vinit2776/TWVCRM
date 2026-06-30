"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import QRCode from "qrcode";
import { ArrowLeft, Printer, Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FacilityAsset } from "@/types";

type Layout = "avery" | "9up";

const GRID: Record<Layout, { cols: number; rows: number; wMm: number; hMm: number }> = {
  avery: { cols: 3, rows: 7, wMm: 63.5, hMm: 38.1 },
  "9up":  { cols: 2, rows: 4, wMm: 100,  hMm: 72   },
};

interface AssetWithQR extends FacilityAsset {
  qrDataUrl: string;
}

export default function BatchPrintPage() {
  return (
    <Suspense fallback={<div className="p-8 text-sm text-muted-foreground text-center">Loading…</div>}>
      <BatchPrintContent />
    </Suspense>
  );
}

function BatchPrintContent() {
  const searchParams = useSearchParams();
  const rawIds = searchParams.get("ids") ?? "";
  const ids = rawIds.split(",").map((s) => s.trim()).filter(Boolean);

  const [assets, setAssets] = useState<AssetWithQR[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [layout, setLayout] = useState<Layout>("avery");
  const [startFrom, setStartFrom] = useState(1);
  const [copies, setCopies] = useState(1);
  const printAreaRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ids.length === 0) { setError("No assets selected."); setLoading(false); return; }

    (async () => {
      try {
        const fetched = await Promise.all(
          ids.map((id) =>
            fetch(`/api/facility/assets/${id}`)
              .then((r) => r.json())
              .then((j) => j.data as FacilityAsset | null)
          )
        );
        const valid = fetched.filter(Boolean) as FacilityAsset[];
        // Sort by location → floor → asset_code
        valid.sort((a, b) => {
          const loc = (a.location?.name ?? "").localeCompare(b.location?.name ?? "");
          if (loc !== 0) return loc;
          const fl = (a.floor?.name ?? "").localeCompare(b.floor?.name ?? "");
          if (fl !== 0) return fl;
          return a.asset_code.localeCompare(b.asset_code);
        });

        const origin = typeof window !== "undefined" ? window.location.origin : "";
        const withQR = await Promise.all(
          valid.map(async (a) => {
            const url = `${origin}/asset/${a.asset_code}`;
            const qrDataUrl = await QRCode.toDataURL(url, {
              width: 400, margin: 1, color: { dark: "#000000", light: "#ffffff" },
            });
            return { ...a, qrDataUrl };
          })
        );
        setAssets(withQR);
      } catch {
        setError("Failed to load assets.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawIds]);

  const { cols, rows, wMm, hMm } = GRID[layout];
  const perPage = cols * rows;
  const totalSlots = startFrom - 1 + assets.length * copies;
  const pages = Math.ceil(totalSlots / perPage);

  const applyStickersUrl = `/facility/assets/apply-stickers?ids=${encodeURIComponent(rawIds)}`;

  const handlePrint = () => {
    const area = printAreaRef.current;
    if (!area) return;
    const origin = window.location.origin;
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
    setTimeout(() => pw.print(), 600);
  };

  if (loading) return <div className="p-8 text-sm text-muted-foreground text-center">Generating QR codes…</div>;
  if (error) return <div className="p-8 text-sm text-red-500 text-center">{error}</div>;

  return (
    <>
      {/* Controls bar */}
      <div data-print-hide className="flex items-center gap-2 px-4 h-14 border-b bg-background flex-wrap sticky top-0 z-10">
        <Link href="/facility/assets">
          <Button variant="ghost" size="sm"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Button>
        </Link>

        <div className="flex items-center gap-1.5 ml-2">
          {(["avery", "9up"] as Layout[]).map((l) => (
            <button
              key={l}
              onClick={() => { setLayout(l); setStartFrom(1); }}
              className="px-3 py-1 rounded text-sm transition-colors"
              style={{ background: layout === l ? "#111" : "#e9e9e9", color: layout === l ? "white" : "#444", border: "none", cursor: "pointer" }}
            >
              {l === "avery" ? "21-up (63.5×38mm)" : "8-up (100×72mm)"}
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 ml-3 text-sm text-muted-foreground">
          Start at label:
          <input
            type="number" min={1} max={perPage} value={startFrom}
            onChange={(e) => setStartFrom(Math.max(1, Math.min(perPage, Number(e.target.value))))}
            className="w-14 px-2 py-0.5 rounded border text-sm text-foreground"
          />
        </label>

        <label className="flex items-center gap-1.5 ml-3 text-sm text-muted-foreground">
          Labels per asset:
          <input
            type="number" min={1} max={3} value={copies}
            onChange={(e) => setCopies(Math.max(1, Math.min(3, Number(e.target.value))))}
            className="w-12 px-2 py-0.5 rounded border text-sm text-foreground"
          />
        </label>

        <div className="ml-auto flex items-center gap-2">
          <Link href={applyStickersUrl}>
            <Button size="sm" variant="outline">
              <Smartphone className="h-4 w-4 mr-1.5" /> Apply stickers
            </Button>
          </Link>
          <Button size="sm" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-1.5" /> Print
          </Button>
        </div>
      </div>

      {/* Hint bar */}
      <div data-print-hide className="text-xs text-muted-foreground px-4 py-2 bg-muted/30 border-b">
        {assets.length} assets · {copies > 1 ? `${copies} labels each · ` : ""}{assets.length * copies} labels total · {pages} page{pages !== 1 ? "s" : ""} ·
        Labels sorted by location → floor → asset code.
        {startFrom > 1 && ` Starting at label #${startFrom} (positions 1–${startFrom - 1} left blank).`}
        {" "}After printing, open <strong>Apply stickers</strong> on your phone to confirm each one.
      </div>

      {/* Print area */}
      <div ref={printAreaRef} style={{ background: "#f0f0f0" }}>

        {/* ── Index page ── */}
        <IndexPage assets={assets} startFrom={startFrom} perPage={perPage} applyStickersUrl={applyStickersUrl} />

        {/* ── Label pages ── */}
        {Array.from({ length: pages }).map((_, pageIdx) => {
          const slotOffset = pageIdx * perPage;
          return (
            <LabelPage
              key={pageIdx}
              assets={assets}
              startFrom={startFrom}
              slotOffset={slotOffset}
              perPage={perPage}
              copies={copies}
              layout={layout}
              wMm={wMm}
              hMm={hMm}
              cols={cols}
              rows={rows}
            />
          );
        })}
      </div>
    </>
  );
}

/* ── Index page ──────────────────────────────────────────────── */
function IndexPage({ assets, startFrom, perPage, applyStickersUrl }: { assets: AssetWithQR[]; startFrom: number; perPage: number; applyStickersUrl: string }) {
  const [indexQR, setIndexQR] = useState<string>("");

  useEffect(() => {
    const fullUrl = typeof window !== "undefined" ? window.location.origin + applyStickersUrl : "";
    if (fullUrl) {
      QRCode.toDataURL(fullUrl, { width: 200, margin: 1, color: { dark: "#000000", light: "#ffffff" } })
        .then(setIndexQR)
        .catch(() => {/* silently skip if URL too long */});
    }
  }, [applyStickersUrl]);

  return (
    <div style={{
      width: "210mm", minHeight: "297mm", margin: "0 auto",
      background: "white", padding: "15mm 15mm 10mm",
      pageBreakAfter: "always",
      fontFamily: "sans-serif",
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "8mm" }}>
        <div>
          <img src="/logo.png" alt="The WorkVilla" style={{ height: "10mm", marginBottom: "3mm" }} />
          <div style={{ fontSize: "16pt", fontWeight: 700 }}>Batch QR Label Index</div>
          <div style={{ fontSize: "8pt", color: "#666", marginTop: "2mm" }}>
            Print this page first. Scan the QR code with your phone to open the guided sticker application.
          </div>
        </div>
        {indexQR && (
          <div style={{ textAlign: "center", flexShrink: 0, marginLeft: "8mm" }}>
            <img src={indexQR} alt="Apply stickers QR" style={{ width: "28mm", height: "28mm" }} />
            <div style={{ fontSize: "6pt", color: "#666", marginTop: "1mm" }}>Scan to apply</div>
          </div>
        )}
      </div>

      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "8pt" }}>
        <thead>
          <tr style={{ background: "#f5f5f5" }}>
            <th style={{ textAlign: "left", padding: "3mm 3mm", borderBottom: "1px solid #ddd", width: "16mm" }}>Label #</th>
            <th style={{ textAlign: "left", padding: "3mm 3mm", borderBottom: "1px solid #ddd", width: "28mm" }}>Code</th>
            <th style={{ textAlign: "left", padding: "3mm 3mm", borderBottom: "1px solid #ddd" }}>Asset Name</th>
            <th style={{ textAlign: "left", padding: "3mm 3mm", borderBottom: "1px solid #ddd" }}>Location / Floor</th>
          </tr>
        </thead>
        <tbody>
          {assets.map((a, i) => {
            const labelNum = startFrom + i;
            const pageNum = Math.ceil(labelNum / perPage);
            const posOnPage = ((labelNum - 1) % perPage) + 1;
            const locationLine = [a.location?.name, a.floor?.name].filter(Boolean).join(" · ");
            return (
              <tr key={a.id} style={{ borderBottom: "0.5px solid #eee" }}>
                <td style={{ padding: "2mm 3mm", color: "#555" }}>
                  <span style={{ fontWeight: 700 }}>#{labelNum}</span>
                  <span style={{ color: "#999", fontSize: "7pt", display: "block" }}>pg {pageNum} pos {posOnPage}</span>
                </td>
                <td style={{ padding: "2mm 3mm", fontFamily: "monospace", fontWeight: 700, fontSize: "7.5pt" }}>{a.asset_code}</td>
                <td style={{ padding: "2mm 3mm" }}>{a.name}</td>
                <td style={{ padding: "2mm 3mm", color: "#666" }}>{locationLine || "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ── Label page ──────────────────────────────────────────────── */
interface LabelPageProps {
  assets: AssetWithQR[];
  startFrom: number;
  slotOffset: number;
  perPage: number;
  copies: number;
  layout: Layout;
  wMm: number;
  hMm: number;
  cols: number;
  rows: number;
}

function LabelPage({ assets, startFrom, slotOffset, perPage, copies, layout, wMm, hMm, cols }: LabelPageProps) {
  const slots = Array.from({ length: perPage }).map((_, slotIdx) => {
    const absoluteSlot = slotOffset + slotIdx; // 0-indexed across all pages
    const labelNum = absoluteSlot + 1; // label number shown on index (1-indexed)
    // Which asset index does this slot correspond to? Each asset occupies `copies` consecutive slots.
    const positionFromStart = labelNum - startFrom; // 0-indexed from first asset slot
    const assetIdx = positionFromStart >= 0 ? Math.floor(positionFromStart / copies) : -1;
    const asset = assetIdx >= 0 && assetIdx < assets.length ? assets[assetIdx] : null;
    return { labelNum, asset };
  });

  const isAvery = layout === "avery";

  return (
    <div style={{
      width: "210mm",
      background: "white",
      margin: "0 auto",
      pageBreakAfter: "always",
      display: "grid",
      gridTemplateColumns: `repeat(${cols}, ${wMm}mm)`,
      gridAutoRows: `${hMm}mm`,
      ...(isAvery
        ? { paddingTop: "15.1mm", paddingLeft: "4.65mm", columnGap: "2.5mm", rowGap: "0mm" }
        : { padding: "5mm", gap: "2mm" }),
    }}>
      {slots.map(({ labelNum, asset }, slotIdx) => (
        <div
          key={slotIdx}
          style={{
            boxSizing: "border-box",
            overflow: "hidden",
            ...(isAvery
              ? { display: "flex", alignItems: "center", gap: "1.5mm", padding: "1mm 2mm" }
              : { border: "0.5px dashed #bbb", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2mm", padding: "2mm" }),
          }}
        >
          {asset ? (
            isAvery
              ? <AveryLabel asset={asset} labelNum={labelNum} />
              : <NineUpLabel asset={asset} labelNum={labelNum} />
          ) : null}
        </div>
      ))}
    </div>
  );
}

function AveryLabel({ asset, labelNum }: { asset: AssetWithQR; labelNum: number }) {
  const locationLine = [asset.location?.name, asset.floor?.name].filter(Boolean).join(" · ");
  return (
    <>
      <div style={{ flexShrink: 0 }}>
        {asset.qrDataUrl && <img src={asset.qrDataUrl} alt="QR" style={{ width: "22mm", height: "22mm" }} />}
      </div>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1, overflow: "hidden" }}>
        <img src="/logo.png" alt="TWV" style={{ width: "28mm", height: "auto" }} />
        <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "7pt", letterSpacing: "0.04em" }}>{asset.asset_code}</div>
        <div style={{ fontSize: "5pt", textAlign: "center", lineHeight: 1.2, maxHeight: "3em", overflow: "hidden" }}>{asset.name}</div>
        {locationLine && <div style={{ fontSize: "4.5pt", color: "#666", textAlign: "center" }}>{locationLine}</div>}
        <div style={{ fontSize: "4pt", color: "#aaa" }}>#{labelNum}</div>
      </div>
    </>
  );
}

function NineUpLabel({ asset, labelNum }: { asset: AssetWithQR; labelNum: number }) {
  const locationLine = [asset.location?.name, asset.floor?.name].filter(Boolean).join(" · ");
  return (
    <>
      <img src="/logo.png" alt="The WorkVilla" style={{ width: "28mm", height: "auto" }} />
      {asset.qrDataUrl && <img src={asset.qrDataUrl} alt="QR code" style={{ width: "32mm", height: "32mm" }} />}
      <div style={{ fontFamily: "monospace", fontWeight: 700, fontSize: "8pt", letterSpacing: "0.04em", textAlign: "center" }}>{asset.asset_code}</div>
      <div style={{ fontSize: "6pt", textAlign: "center", lineHeight: 1.2 }}>{asset.name}</div>
      {locationLine && <div style={{ fontSize: "5pt", color: "#666", textAlign: "center" }}>{locationLine}</div>}
      <div style={{ fontSize: "5pt", color: "#aaa" }}>#{labelNum}</div>
    </>
  );
}

"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Eye, Loader2, Minus, Plus, Stamp } from "lucide-react";
import { toast } from "sonner";

interface StampUploadedDocumentProps {
  caseId: string;
  agreementId: string;
  signedDocumentId: string;
  onStamped: () => void;
}

// Bytes → base64 without Buffer (browser context). Chunked to stay well under
// the string-arg limits some engines impose on String.fromCharCode.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// pdfjs-dist needs a worker script; loading it from jsdelivr (pinned to the
// exact installed version) sidesteps bundler-specific worker-asset wiring,
// the same way the contract page does.
async function getPdfJs() {
  const pdfjsLib = await import("pdfjs-dist");
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/build/pdf.worker.min.mjs`;
  return pdfjsLib;
}

/**
 * "Stamp uploaded document" for a case's Leave & License agreement: puts TWV's
 * signature and seal on top of the signed copy already uploaded (for example a
 * customer-signed scan), keeping the customer's signature. The contract page
 * has the same flow inline; an uploaded PDF has no known layout, so the admin
 * picks the page and clicks where the stamp should sit.
 */
export function StampUploadedDocument({ caseId, agreementId, signedDocumentId, onStamped }: StampUploadedDocumentProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [sourceBytes, setSourceBytes] = useState<Uint8Array | null>(null);
  const [originalUrl, setOriginalUrl] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [targetPage, setTargetPage] = useState(1);
  const [pageImageUrl, setPageImageUrl] = useState<string | null>(null);
  const [pageImageLoading, setPageImageLoading] = useState(false);
  // Null until the admin clicks, which gates "Confirm & save" so nothing is
  // saved at a guessed spot.
  const [clickRatio, setClickRatio] = useState<{ x: number; y: number } | null>(null);
  const [rendering, setRendering] = useState(false);
  const [stampRef, setStampRef] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewPdfBase64, setPreviewPdfBase64] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setOpen(false);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    if (originalUrl) URL.revokeObjectURL(originalUrl);
    setSourceBytes(null);
    setOriginalUrl(null);
    setPageCount(0);
    setTargetPage(1);
    setPageImageUrl(null);
    setClickRatio(null);
    setStampRef(null);
    setPreviewUrl(null);
    setPreviewPdfBase64(null);
    setError(null);
  };

  // Rasterizes one page for the click-to-place picker. pdfjs can detach the
  // buffer it is given, and pdf-lib reloads the same bytes afterwards, so it
  // gets a copy.
  const renderPageImage = async (bytes: Uint8Array, pageNumber: number) => {
    setPageImageLoading(true);
    try {
      const pdfjsLib = await getPdfJs();
      const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
      const page = await pdf.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas rendering isn't supported in this browser");
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      setPageImageUrl(canvas.toDataURL("image/png"));
    } finally {
      setPageImageLoading(false);
    }
  };

  // Draws the signature + seal centered on the clicked point onto a pristine
  // copy of the uploaded PDF, so clicking again moves the stamp rather than
  // stacking a second one.
  const renderStampPreview = async (bytes: Uint8Array, pageNumber: number, ref: string, xRatio: number, yRatio: number) => {
    const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
    const { COMPANY_SIGNATURE_BASE64 } = await import("@/lib/signature-data");
    const { COMPANY_SEAL_BASE64 } = await import("@/lib/seal-data");

    const pdfDoc = await PDFDocument.load(bytes);
    const pages = pdfDoc.getPages();
    const page = pages[Math.min(Math.max(pageNumber, 1), pages.length) - 1];
    const { width, height } = page.getSize();

    const dataUriToBytes = (dataUri: string) =>
      Uint8Array.from(atob(dataUri.split(",")[1]), (c) => c.charCodeAt(0));
    const sigImage = await pdfDoc.embedPng(dataUriToBytes(COMPANY_SIGNATURE_BASE64));
    const sealImage = await pdfDoc.embedPng(dataUriToBytes(COMPANY_SEAL_BASE64));
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

    const sealSize = 44;
    const sigH = 26;
    const sigW = sigH * (sigImage.width / sigImage.height);
    const gap = 6;
    const clusterWidth = sigW + gap + sealSize;
    const clusterHeight = Math.max(sigH, sealSize);
    const margin = 4;

    // PDF origin is bottom-left; the click is measured from the top-left of
    // the rendered image, so the y-axis flips here.
    const clickX = xRatio * width;
    const clickY = height - yRatio * height;
    const clusterLeft = Math.min(Math.max(clickX - clusterWidth / 2, margin), width - clusterWidth - margin);
    const clusterBottom = Math.min(Math.max(clickY - clusterHeight / 2, margin + 12), height - clusterHeight - margin);

    const sigY = clusterBottom + (clusterHeight - sigH) / 2;
    const sealX = clusterLeft + sigW + gap;
    const sealY = clusterBottom + (clusterHeight - sealSize) / 2;

    page.drawImage(sigImage, { x: clusterLeft, y: sigY, width: sigW, height: sigH });
    page.drawImage(sealImage, { x: sealX, y: sealY, width: sealSize, height: sealSize });
    page.drawText(`TWV Ref: ${ref}`, { x: clusterLeft, y: clusterBottom - 9, size: 5.5, font, color: rgb(0.5, 0.5, 0.5) });

    const stampedBytes = await pdfDoc.save();
    const blobUrl = URL.createObjectURL(new Blob([new Uint8Array(stampedBytes)], { type: "application/pdf" }));
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return blobUrl;
    });
    setPreviewPdfBase64(bytesToBase64(stampedBytes));
  };

  const handleOpen = async () => {
    setLoading(true);
    setError(null);
    try {
      const viewRes = await fetch(`/api/documents/${signedDocumentId}/view`);
      if (!viewRes.ok) throw new Error("Failed to get the uploaded document's URL");
      const { signedUrl } = await viewRes.json();
      const fileRes = await fetch(signedUrl);
      if (!fileRes.ok) throw new Error("Failed to download the uploaded document");
      const bytes = new Uint8Array(await fileRes.arrayBuffer());

      const { PDFDocument } = await import("pdf-lib");
      const { generateStampReference } = await import("@/lib/company-stamp");
      const count = (await PDFDocument.load(bytes)).getPageCount();

      setSourceBytes(bytes);
      setOriginalUrl(URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" })));
      setPageCount(count);
      // The signature block is usually on the last page.
      setTargetPage(count);
      setClickRatio(null);
      setStampRef(generateStampReference());
      setPreviewUrl(null);
      setPreviewPdfBase64(null);
      await renderPageImage(bytes, count);
      setOpen(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not open the uploaded document. Only PDF copies can be stamped.");
    } finally {
      setLoading(false);
    }
  };

  const handlePageChange = async (pageNumber: number) => {
    if (!sourceBytes) return;
    const clamped = Math.min(Math.max(pageNumber, 1), pageCount || 1);
    setTargetPage(clamped);
    // A point chosen on the old page means nothing on this one.
    setClickRatio(null);
    setPreviewUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setPreviewPdfBase64(null);
    try {
      await renderPageImage(sourceBytes, clamped);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to render that page");
    }
  };

  const handleImageClick = async (e: React.MouseEvent<HTMLImageElement>) => {
    if (!sourceBytes || !stampRef) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xRatio = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    const yRatio = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 1);
    setClickRatio({ x: xRatio, y: yRatio });
    setRendering(true);
    try {
      await renderStampPreview(sourceBytes, targetPage, stampRef, xRatio, yRatio);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update preview");
    } finally {
      setRendering(false);
    }
  };

  const handleSave = async () => {
    if (!previewPdfBase64 || !stampRef) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/cases/${caseId}/leave-license/stamp-existing-document`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agreement_id: agreementId, pdfBase64: previewPdfBase64, stampRef }),
      });
      if (res.ok) {
        toast.success(`Signed copy stamped with company sign & seal (${stampRef})`);
        close();
        onStamped();
      } else {
        const err = await res.json().catch(() => null);
        setError(err?.error || "Failed to stamp the document");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to stamp the document");
    } finally {
      setSaving(false);
    }
  };

  const busy = rendering || pageImageLoading;

  return (
    <>
      <Button size="sm" variant="outline" onClick={handleOpen} disabled={loading}>
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Stamp className="mr-2 h-4 w-4" />}
        Stamp uploaded document
      </Button>

      <Dialog open={open} onOpenChange={(o) => { if (!o) close(); }}>
        <DialogContent className="max-w-3xl max-h-[90vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Preview: stamp uploaded document</DialogTitle>
            <DialogDescription>
              Click the page below where TWV&apos;s signature and seal should go on the signed copy already
              uploaded. The customer&apos;s signature is kept, ref {stampRef}. This does not go through Leegality.
              You can undo it afterward from &quot;Cancel sign &amp; seal&quot;.
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto">
            {pageCount > 0 && (
              <div className="rounded-md border bg-amber-50 border-amber-200 p-4 space-y-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="text-sm text-amber-900">Page</span>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={busy || targetPage <= 1}
                    onClick={() => handlePageChange(targetPage - 1)}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <Input
                    type="number"
                    min={1}
                    max={pageCount}
                    value={targetPage}
                    onChange={(e) => {
                      const n = parseInt(e.target.value, 10);
                      if (!isNaN(n)) handlePageChange(n);
                    }}
                    disabled={busy}
                    className="h-7 w-14 text-center px-1"
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    className="h-7 w-7"
                    disabled={busy || targetPage >= pageCount}
                    onClick={() => handlePageChange(targetPage + 1)}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-sm text-amber-900">of {pageCount}</span>
                  {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-amber-900" />}
                  {originalUrl && (
                    <Button asChild variant="outline" size="sm" className="ml-auto">
                      <a href={originalUrl} target="_blank" rel="noopener noreferrer">
                        <Eye className="mr-1.5 h-3.5 w-3.5" />
                        Open original full PDF
                      </a>
                    </Button>
                  )}
                </div>
                {pageImageUrl && (
                  <div className="relative inline-block max-w-full rounded border bg-white">
                    {/* eslint-disable-next-line @next/next/no-img-element -- data: URL raster of an uploaded PDF page, not an optimizable asset */}
                    <img
                      src={pageImageUrl}
                      alt={`Page ${targetPage} of the uploaded document`}
                      className="w-full h-auto rounded cursor-crosshair select-none"
                      onClick={handleImageClick}
                    />
                    {clickRatio && (
                      <div
                        className="absolute w-4 h-4 rounded-full border-2 border-red-500 bg-red-500/30 pointer-events-none"
                        style={{ left: `${clickRatio.x * 100}%`, top: `${clickRatio.y * 100}%`, transform: "translate(-50%, -50%)" }}
                      />
                    )}
                  </div>
                )}
                <p className="text-sm text-amber-900">
                  {clickRatio
                    ? "Click again anywhere to move the stamp — the marker shows its current spot."
                    : "Click on the page above where the stamp should go."}
                </p>
              </div>
            )}
            {previewUrl && (
              <div className="rounded-md border bg-muted/30 p-4 flex items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">Review the exact PDF before confirming.</p>
                <Button asChild variant="outline" size="sm" className="shrink-0">
                  <a href={previewUrl} target="_blank" rel="noopener noreferrer">
                    <Eye className="mr-1.5 h-3.5 w-3.5" />
                    Open preview PDF
                  </a>
                </Button>
              </div>
            )}
            {error && (
              <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={close}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !previewPdfBase64}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Stamping...
                </>
              ) : (
                "Confirm & save"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

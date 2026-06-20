"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { X, Camera, AlertCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface QRScannerDialogProps {
  open: boolean;
  onClose: () => void;
}

type ScanState = "starting" | "scanning" | "found" | "error";

export function QRScannerDialog({ open, onClose }: QRScannerDialogProps) {
  const router = useRouter();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // readerRef only used for dynamic import deduplication; scanning stops when stream stops
  const readerRef = useRef<boolean>(false);
  const [scanState, setScanState] = useState<ScanState>("starting");
  const [errorMsg, setErrorMsg] = useState("");

  // Start / stop camera when dialog opens/closes
  useEffect(() => {
    if (!open) {
      stopCamera();
      setScanState("starting");
      setErrorMsg("");
      return;
    }
    startCamera();
    return () => stopCamera();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function startCamera() {
    if (readerRef.current) return; // already running
    setScanState("starting");
    try {
      const { BrowserMultiFormatReader } = await import("@zxing/browser");
      const reader = new BrowserMultiFormatReader();

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;

      if (!videoRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      videoRef.current.srcObject = stream;
      await videoRef.current.play();

      setScanState("scanning");
      readerRef.current = true;

      reader.decodeFromStream(stream, videoRef.current, (result) => {
        if (!result || !readerRef.current) return;
        handleScanResult(result.getText());
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Camera access denied";
      setErrorMsg(
        msg.includes("denied") || msg.includes("Permission")
          ? "Camera permission was denied. Please allow camera access in your browser settings."
          : "Could not access camera. Make sure no other app is using it."
      );
      setScanState("error");
    }
  }

  function stopCamera() {
    readerRef.current = false;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  async function handleScanResult(text: string) {
    // Only process once
    setScanState("found");
    stopCamera();

    // Extract asset code from URL pattern: /asset/<code>
    // Handles both full URLs (twv-crm.vercel.app/asset/TWV-001) and bare codes
    let code: string | null = null;
    try {
      const url = new URL(text);
      const match = url.pathname.match(/^\/asset\/([^/]+)/);
      if (match) code = match[1];
    } catch {
      // Not a URL — treat the raw text as asset code
      if (/^[A-Z0-9-]+$/.test(text.trim())) code = text.trim();
    }

    if (!code) {
      toast.error("QR code not recognised as a WorkVilla asset");
      readerRef.current = false;
      setScanState("scanning");
      startCamera();
      return;
    }

    try {
      const res = await fetch(`/api/public/asset/${encodeURIComponent(code)}`);
      const json = await res.json();
      if (!res.ok || !json.data?.id) {
        toast.error(`Asset "${code}" not found`);
        setScanState("scanning");
        startCamera();
        return;
      }
      onClose();
      router.push(`/facility/assets/${json.data.id}`);
    } catch {
      toast.error("Failed to look up asset. Check your connection.");
      readerRef.current = false;
      setScanState("scanning");
      startCamera();
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-black/80 backdrop-blur-sm">
        <div className="flex items-center gap-2 text-white">
          <Camera className="h-4 w-4" />
          <span className="text-sm font-medium">Scan Asset QR Code</span>
        </div>
        <button onClick={onClose} className="text-white/70 hover:text-white p-1">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Camera viewport */}
      <div className="flex-1 relative overflow-hidden bg-black">
        <video
          ref={videoRef}
          className="absolute inset-0 w-full h-full object-cover"
          muted
          playsInline
          autoPlay
        />

        {/* Scan overlay */}
        {scanState === "scanning" && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="relative w-64 h-64">
              {/* Corner markers */}
              <div className="absolute top-0 left-0 w-8 h-8 border-t-4 border-l-4 border-white rounded-tl-sm" />
              <div className="absolute top-0 right-0 w-8 h-8 border-t-4 border-r-4 border-white rounded-tr-sm" />
              <div className="absolute bottom-0 left-0 w-8 h-8 border-b-4 border-l-4 border-white rounded-bl-sm" />
              <div className="absolute bottom-0 right-0 w-8 h-8 border-b-4 border-r-4 border-white rounded-br-sm" />
              {/* Scan line animation */}
              <div className="absolute inset-x-2 top-2 bottom-2 overflow-hidden">
                <div className="h-0.5 bg-white/70 w-full animate-scan" />
              </div>
            </div>
          </div>
        )}

        {/* Starting overlay */}
        {scanState === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="flex flex-col items-center gap-3 text-white">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-sm">Starting camera…</p>
            </div>
          </div>
        )}

        {/* Found overlay */}
        {scanState === "found" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60">
            <div className="flex flex-col items-center gap-3 text-white">
              <Loader2 className="h-8 w-8 animate-spin" />
              <p className="text-sm">Loading asset…</p>
            </div>
          </div>
        )}

        {/* Error overlay */}
        {scanState === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80 p-6">
            <div className="flex flex-col items-center gap-4 text-center">
              <AlertCircle className="h-10 w-10 text-red-400" />
              <p className="text-white text-sm leading-relaxed">{errorMsg}</p>
              <Button variant="outline" size="sm" onClick={() => { setScanState("starting"); startCamera(); }}>
                Try Again
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-3 bg-black/80 text-center">
        <p className="text-xs text-white/60">
          Point the camera at a WorkVilla asset QR label
        </p>
      </div>

      <style>{`
        @keyframes scan {
          0% { transform: translateY(0); }
          50% { transform: translateY(240px); }
          100% { transform: translateY(0); }
        }
        .animate-scan { animation: scan 2s ease-in-out infinite; }
      `}</style>
    </div>
  );
}

"use client";

/**
 * Reusable photo upload for stock transfer receive/issue reporting.
 * Mirrors FacilityPhotoUpload (src/components/facility/photo-upload.tsx)
 * but targets the stock-transfer-photos bucket. Photos are evidence for
 * any complaints raised afterward — display is view-only, no edit.
 */

import { useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { prepareUpload, UploadTooLargeError } from "@/lib/uploads/upload-gate";

export type UploadedTransferPhoto = {
  file_url: string;
  file_path: string;
  file_type: "image";
  caption?: string | null;
};

interface Props {
  pathPrefix?: string;
  onUploaded: (photo: UploadedTransferPhoto) => void;
  photos?: UploadedTransferPhoto[];
  onRemove?: (index: number) => void;
  disabled?: boolean;
}

const BUCKET = "stock-transfer-photos";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export function TransferPhotoUpload({
  pathPrefix = "transfer",
  onUploaded,
  photos = [],
  onRemove,
  disabled = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    const supabase = createClient();
    try {
      for (const raw of Array.from(files)) {
        if (raw.size > MAX_BYTES) {
          toast.error(`${raw.name} is over 10MB — skipped`);
          continue;
        }
        let file: File | null;
        try {
          file = await prepareUpload(raw);
        } catch (e) {
          if (e instanceof UploadTooLargeError) {
            toast.error(e.message);
          } else {
            toast.error(e instanceof Error ? e.message : "Upload prep failed");
          }
          continue;
        }
        if (!file) continue;

        const path = `${pathPrefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, { contentType: file.type, upsert: false });
        if (error) {
          toast.error(`Upload failed: ${error.message}`);
          continue;
        }

        const { data: signed } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(path, 60 * 60 * 24 * 365);

        onUploaded({
          file_url: signed?.signedUrl || path,
          file_path: path,
          file_type: "image",
        });
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        capture="environment"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Uploading…
          </>
        ) : (
          <>
            <Camera className="h-4 w-4 mr-2 sm:hidden" />
            <ImagePlus className="h-4 w-4 mr-2 hidden sm:inline-flex" />
            Add photo
          </>
        )}
      </Button>

      {photos.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {photos.map((p, i) => (
            <div
              key={p.file_path + i}
              className="relative h-16 w-16 shrink-0 rounded-md overflow-hidden border bg-muted"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.file_url} alt="Attachment" className="h-full w-full object-cover" />
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full bg-black/60 text-white flex items-center justify-center"
                  aria-label="Remove"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

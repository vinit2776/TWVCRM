"use client";

/**
 * Reusable photo upload component for facility issues.
 *
 * Renders a camera-style "Add photo" button + thumbnail strip of pending
 * uploads. Returns the uploaded file metadata via `onUploaded`.
 *
 * On mobile, the <input type="file"> with capture="environment" hint will
 * open the camera directly when supported. Files are compressed client-side
 * before upload to keep mobile data usage reasonable.
 */

import { useRef, useState } from "react";
import { Camera, ImagePlus, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { compressImageClient } from "@/lib/uploads/compress-image-client";

export type UploadedPhoto = {
  file_url: string;
  file_path: string;
  file_type: "image" | "document";
  caption?: string | null;
};

interface Props {
  /** Where the file lives in storage. Defaults to "issue/<random>". */
  pathPrefix?: string;
  /** Called for each successfully uploaded file. */
  onUploaded: (photo: UploadedPhoto) => void;
  /** Already-uploaded photos (for the thumbnail strip). */
  photos?: UploadedPhoto[];
  /** Allow removing a thumbnail. Optional. */
  onRemove?: (index: number) => void;
  /** Allow multi-select. Default true. */
  multiple?: boolean;
  /** Compact (icon only) vs full button. */
  compact?: boolean;
  /** Disable while parent is busy. */
  disabled?: boolean;
}

const BUCKET = "facility-issue-photos";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

export function FacilityPhotoUpload({
  pathPrefix = "issue",
  onUploaded,
  photos = [],
  onRemove,
  multiple = true,
  compact = false,
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
        const file = await compressImageClient(raw);
        const ext = file.name.split(".").pop()?.toLowerCase() || "jpg";
        const path = `${pathPrefix}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const { error } = await supabase.storage
          .from(BUCKET)
          .upload(path, file, { contentType: file.type, upsert: false });
        if (error) {
          toast.error(`Upload failed: ${error.message}`);
          continue;
        }

        // Public URL works for the bucket; for private buckets we'd sign.
        // We use a short signed URL — 1 year — for in-app display.
        const { data: signed } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(path, 60 * 60 * 24 * 365);

        onUploaded({
          file_url: signed?.signedUrl || path,
          file_path: path,
          file_type: file.type.startsWith("image/") ? "image" : "document",
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
        accept="image/*,application/pdf"
        multiple={multiple}
        capture="environment"
        className="hidden"
        onChange={(e) => handleFiles(e.target.files)}
      />
      <Button
        type="button"
        variant="outline"
        size={compact ? "sm" : "default"}
        disabled={disabled || busy}
        onClick={() => inputRef.current?.click()}
        className="w-full justify-center sm:w-auto sm:justify-start"
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
              className="relative h-20 w-20 shrink-0 rounded-md overflow-hidden border bg-muted"
            >
              {p.file_type === "image" ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={p.file_url}
                  alt={p.caption ?? "Attachment"}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="h-full w-full flex items-center justify-center text-xs text-muted-foreground">
                  PDF
                </div>
              )}
              {onRemove && (
                <button
                  type="button"
                  onClick={() => onRemove(i)}
                  className="absolute top-0.5 right-0.5 h-5 w-5 rounded-full bg-black/60 text-white flex items-center justify-center"
                  aria-label="Remove"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Re-export for callers that only need the type. */
export type { UploadedPhoto as FacilityUploadedPhoto };

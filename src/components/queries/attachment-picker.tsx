"use client";

import { useRef } from "react";
import { Paperclip, X } from "lucide-react";
import { MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/queries/types";

/**
 * File picker for a query message. Holds the selected files until the message
 * is sent — nothing uploads until you actually post, so backing out of a
 * half-written question leaves no orphans in storage.
 */

export function formatBytes(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentPicker({
  files,
  onChange,
  disabled,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const atLimit = files.length >= MAX_ATTACHMENTS_PER_MESSAGE;

  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input
        ref={inputRef}
        type="file"
        multiple
        accept="image/*,application/pdf"
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          onChange([...files, ...picked].slice(0, MAX_ATTACHMENTS_PER_MESSAGE));
          // Reset so picking the same file twice in a row still fires onChange.
          e.target.value = "";
        }}
      />

      <button
        type="button"
        disabled={disabled || atLimit}
        onClick={() => inputRef.current?.click()}
        title={atLimit ? `Maximum ${MAX_ATTACHMENTS_PER_MESSAGE} attachments` : "Attach a screenshot or PDF"}
        className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border text-muted-foreground hover:bg-muted disabled:opacity-50"
      >
        <Paperclip className="h-3 w-3" />
        Attach
      </button>

      {files.map((f, i) => (
        <span
          key={`${f.name}-${i}`}
          className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded border bg-muted/60 max-w-[220px]"
        >
          <span className="truncate" title={f.name}>{f.name}</span>
          <span className="text-muted-foreground flex-none">{formatBytes(f.size)}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange(files.filter((_, idx) => idx !== i))}
            className="text-muted-foreground hover:text-foreground flex-none"
            aria-label={`Remove ${f.name}`}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

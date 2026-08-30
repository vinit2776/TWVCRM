"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface MentionUser {
  id: string;
  full_name: string;
  role: string;
}

interface Trigger {
  /** Index of the "@" in `value` that opened the menu. */
  start: number;
  query: string;
}

interface MentionTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Fires with the IDs of every roster user whose "@Full Name" currently appears verbatim in the text. */
  onMentionedIdsChange?: (ids: string[]) => void;
  roster: MentionUser[];
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  className?: string;
}

function findTrigger(value: string, caret: number): Trigger | null {
  const upToCaret = value.slice(0, caret);
  const at = upToCaret.lastIndexOf("@");
  if (at === -1) return null;
  const before = upToCaret[at - 1];
  if (at > 0 && before && !/\s/.test(before)) return null; // "@" must start a word
  const query = upToCaret.slice(at + 1);
  if (/\s/.test(query)) return null; // typing moved past the mention
  return { start: at, query };
}

/**
 * Plain-text Textarea with a "@name" autocomplete popover. Renamed/typo'd
 * mentions just fall back to plain text — see onMentionedIdsChange, which
 * only reports names that still match a roster entry verbatim.
 */
export function MentionTextarea({
  value,
  onChange,
  onMentionedIdsChange,
  roster,
  placeholder,
  rows = 2,
  maxLength,
  className,
}: MentionTextareaProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const matches = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    return roster.filter((u) => u.full_name.toLowerCase().includes(q)).slice(0, 6);
  }, [trigger, roster]);

  useEffect(() => setActiveIndex(0), [trigger?.query]);

  useEffect(() => {
    if (!onMentionedIdsChange) return;
    onMentionedIdsChange(roster.filter((u) => value.includes(`@${u.full_name}`)).map((u) => u.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, roster]);

  const openMenuAtCaret = () => {
    const ta = taRef.current;
    if (!ta) return;
    setTrigger(findTrigger(value, ta.selectionStart));
  };

  const pick = (u: MentionUser) => {
    const ta = taRef.current;
    if (!ta || !trigger) return;
    const caret = ta.selectionStart;
    const inserted = `@${u.full_name} `;
    const next = value.slice(0, trigger.start) + inserted + value.slice(caret);
    onChange(next);
    setTrigger(null);
    const pos = trigger.start + inserted.length;
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  return (
    <div className="relative">
      <Textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setTrigger(findTrigger(e.target.value, e.target.selectionStart));
        }}
        onClick={openMenuAtCaret}
        onKeyUp={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") openMenuAtCaret();
        }}
        onKeyDown={(e) => {
          if (!trigger || matches.length === 0) return;
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActiveIndex((i) => (i + 1) % matches.length);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActiveIndex((i) => (i - 1 + matches.length) % matches.length);
          } else if (e.key === "Enter" || e.key === "Tab") {
            e.preventDefault();
            pick(matches[activeIndex]);
          } else if (e.key === "Escape") {
            setTrigger(null);
          }
        }}
        onBlur={() => setTimeout(() => setTrigger(null), 120)}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        className={className}
      />
      {trigger && (
        <div className="absolute z-20 top-full left-0 mt-1 w-72 max-h-56 overflow-y-auto rounded-md border bg-popover shadow-md p-1">
          {matches.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground italic">No matching users</p>
          ) : (
            matches.map((u, i) => (
              <button
                key={u.id}
                type="button"
                // onMouseDown (not onClick) fires before the textarea's onBlur closes the menu.
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(u);
                }}
                className={cn(
                  "w-full flex items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted",
                  i === activeIndex && "bg-muted"
                )}
              >
                <span>{u.full_name}</span>
                <span className="text-xs text-muted-foreground capitalize">{u.role.replace(/_/g, " ")}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

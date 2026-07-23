"use client";

import { useState } from "react";
import { Sparkles, Loader2, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface ImproveWordingButtonProps {
  description: string;
  onApply: (text: string) => void;
}

export function ImproveWordingButton({ description, onApply }: ImproveWordingButtonProps) {
  const [loading, setLoading] = useState(false);
  const [suggestion, setSuggestion] = useState<string | null>(null);

  const handleSuggest = async () => {
    if (!description.trim()) {
      toast.error("Type a rough description first");
      return;
    }
    setLoading(true);
    setSuggestion(null);
    try {
      const res = await fetch("/api/usage-charges/suggest-description", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ raw: description }),
      });
      const json = await res.json();
      if (res.ok && json.suggestion) {
        setSuggestion(json.suggestion);
      } else {
        toast.error(json.error || "Couldn't generate a suggestion");
      }
    } catch {
      toast.error("Couldn't generate a suggestion");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleSuggest}
        disabled={loading}
        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
      >
        {loading ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <Sparkles className="h-3 w-3 mr-1" />
        )}
        Improve wording
      </Button>
      {suggestion && (
        <div className="rounded-md border border-primary/30 bg-primary/5 p-2 text-sm space-y-1.5">
          <p>{suggestion}</p>
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                onApply(suggestion);
                setSuggestion(null);
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
            >
              <Check className="h-3 w-3" /> Use this
            </button>
            <button
              type="button"
              onClick={() => setSuggestion(null)}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline"
            >
              <X className="h-3 w-3" /> Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

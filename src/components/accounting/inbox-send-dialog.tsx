"use client";

import { useState } from "react";
import { X, Plus, Send, Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface InboxSendDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Saved billing distribution list — cannot be removed. Primary email first. */
  savedRecipients: string[];
  sending: boolean;
  onConfirm: (extraRecipients: string[]) => void;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function InboxSendDialog({
  open,
  onOpenChange,
  savedRecipients,
  sending,
  onConfirm,
}: InboxSendDialogProps) {
  const [extraInput, setExtraInput] = useState("");
  const [extras, setExtras] = useState<string[]>([]);
  const [inputError, setInputError] = useState<string | null>(null);

  function addExtra() {
    const val = extraInput.trim().toLowerCase();
    if (!val) return;
    if (!EMAIL_RE.test(val)) { setInputError("Invalid email address"); return; }
    if (savedRecipients.includes(val) || extras.includes(val)) { setInputError("Already in list"); return; }
    setExtras((prev) => [...prev, val]);
    setExtraInput("");
    setInputError(null);
  }

  function removeExtra(email: string) {
    setExtras((prev) => prev.filter((e) => e !== email));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); addExtra(); }
  }

  function handleConfirm() {
    onConfirm(extras);
    // reset one-time extras after confirming
    setExtras([]);
    setExtraInput("");
    setInputError(null);
  }

  function handleClose(v: boolean) {
    if (!sending) {
      onOpenChange(v);
      setExtras([]);
      setExtraInput("");
      setInputError(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-4 w-4 text-primary" />
            Send GST Invoice to Customer
          </DialogTitle>
          <DialogDescription>
            The invoice PDF will be emailed to all addresses below.
          </DialogDescription>
        </DialogHeader>

        {/* Saved distribution list — read-only */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Billing distribution list
          </p>
          <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
            {savedRecipients.length === 0 ? (
              <p className="text-sm text-muted-foreground">No email on file</p>
            ) : (
              savedRecipients.map((email, i) => (
                <div key={email} className="flex items-center gap-2 text-sm">
                  <Mail className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <span className="font-mono text-xs">{email}</span>
                  {i === 0 && (
                    <span className="ml-auto text-[10px] bg-primary/10 text-primary px-1.5 py-0.5 rounded font-medium">
                      Primary
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        {/* One-time extras */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Add one-time recipient (this send only)
          </p>
          <div className="flex gap-2">
            <Input
              placeholder="colleague@company.com"
              value={extraInput}
              onChange={(e) => { setExtraInput(e.target.value); setInputError(null); }}
              onKeyDown={handleKeyDown}
              disabled={sending}
              className="h-8 text-sm"
            />
            <Button variant="outline" size="sm" onClick={addExtra} disabled={sending || !extraInput.trim()}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {inputError && <p className="text-xs text-destructive">{inputError}</p>}
          {extras.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {extras.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1 text-xs bg-secondary text-secondary-foreground px-2 py-0.5 rounded-full"
                >
                  {email}
                  <button onClick={() => removeExtra(email)} className="hover:text-destructive" disabled={sending}>
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => handleClose(false)} disabled={sending}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={sending || savedRecipients.length === 0}>
            {sending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Send Invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

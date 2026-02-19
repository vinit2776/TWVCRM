"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Loader2, Copy } from "lucide-react";
import { toast } from "sonner";

interface Contract {
  id: string;
  contract_number: string;
  lead?: { first_name: string; last_name: string; company?: string };
}

interface CopyFacilitiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  targetContractId: string;
}

export function CopyFacilitiesDialog({
  open,
  onOpenChange,
  onSuccess,
  targetContractId,
}: CopyFacilitiesDialogProps) {
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [sourceContractId, setSourceContractId] = useState("");
  const [loading, setLoading] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    if (open) {
      setLoading(true);
      fetch("/api/contracts?status=active&limit=100")
        .then((r) => r.json())
        .then((d) => {
          const filtered = (d.data || []).filter((c: Contract) => c.id !== targetContractId);
          setContracts(filtered);
        })
        .catch(() => setContracts([]))
        .finally(() => setLoading(false));
    }
  }, [open, targetContractId]);

  const handleCopy = async () => {
    if (!sourceContractId) {
      toast.error("Select a source contract");
      return;
    }

    setCopying(true);
    try {
      const res = await fetch("/api/accounting/contract-facilities/copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_contract_id: sourceContractId,
          target_contract_id: targetContractId,
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        toast.error(err.error || "Failed to copy facilities");
        return;
      }

      const { copied_count } = await res.json();
      toast.success(`${copied_count} facilities copied`);
      onSuccess();
      onOpenChange(false);
    } catch {
      toast.error("Network error");
    } finally {
      setCopying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Copy Facilities from Contract</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label>Source Contract</Label>
            {loading ? (
              <div className="flex items-center gap-2 py-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span className="text-sm text-muted-foreground">Loading contracts...</span>
              </div>
            ) : (
              <Select value={sourceContractId} onValueChange={setSourceContractId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a contract" />
                </SelectTrigger>
                <SelectContent>
                  {contracts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.contract_number} — {c.lead?.company || `${c.lead?.first_name} ${c.lead?.last_name}`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <p className="text-sm text-muted-foreground">
            All active facilities from the selected contract will be copied to this contract.
            Facilities that already exist (by name) will be skipped.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleCopy} disabled={copying || !sourceContractId}>
            {copying ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Copy className="mr-2 h-4 w-4" />
            )}
            Copy Facilities
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

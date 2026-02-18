"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { Location } from "@/types";

interface LocationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  location?: Location | null;
  onSuccess: () => void;
}

export function LocationFormDialog({
  open,
  onOpenChange,
  location,
  onSuccess,
}: LocationFormDialogProps) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [isActive, setIsActive] = useState(true);
  const [saving, setSaving] = useState(false);

  const isEdit = !!location;

  useEffect(() => {
    if (location) {
      setName(location.name);
      setCode(location.code);
      setAddress(location.address || "");
      setCity(location.city || "");
      setState(location.state || "");
      setIsActive(location.is_active);
    } else {
      setName("");
      setCode("");
      setAddress("");
      setCity("");
      setState("");
      setIsActive(true);
    }
  }, [location, open]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!name.trim() || !code.trim()) {
      toast.error("Name and code are required");
      return;
    }

    setSaving(true);
    try {
      const payload = { name, code: code.toUpperCase(), address, city, state, is_active: isActive };

      const res = isEdit
        ? await fetch(`/api/locations/${location.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/locations", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

      const json = await res.json();

      if (res.ok) {
        toast.success(isEdit ? "Location updated" : "Location created");
        onSuccess();
        onOpenChange(false);
      } else {
        toast.error(json.error || "Failed to save location");
      }
    } catch {
      toast.error("Failed to save location");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>{isEdit ? "Edit Location" : "Add Location"}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="loc-name">Name *</Label>
              <Input
                id="loc-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g., Nungambakkam"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc-code">Code *</Label>
              <Input
                id="loc-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 10))}
                placeholder="e.g., NGB"
                maxLength={10}
                required
              />
              <p className="text-xs text-muted-foreground">Short unique identifier</p>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="loc-address">Address</Label>
            <Textarea
              id="loc-address"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Full address"
              rows={2}
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="loc-city">City</Label>
              <Input
                id="loc-city"
                value={city}
                onChange={(e) => setCity(e.target.value)}
                placeholder="e.g., Chennai"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="loc-state">State</Label>
              <Input
                id="loc-state"
                value={state}
                onChange={(e) => setState(e.target.value)}
                placeholder="e.g., Tamil Nadu"
              />
            </div>
          </div>

          {isEdit && (
            <div className="flex items-center justify-between rounded-md border p-3">
              <div>
                <Label>Active</Label>
                <p className="text-xs text-muted-foreground">Inactive locations are hidden from dropdowns</p>
              </div>
              <Button
                type="button"
                variant={isActive ? "default" : "outline"}
                size="sm"
                onClick={() => setIsActive(!isActive)}
              >
                {isActive ? "Active" : "Inactive"}
              </Button>
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !name.trim() || !code.trim()}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : isEdit ? (
                "Update"
              ) : (
                "Create"
              )}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "sonner";
import {
  UserPlus,
  Fingerprint,
  CreditCard,
  Send,
  Loader2,
  ShieldCheck,
  ShieldOff,
  Wifi,
  WifiOff,
  Trash2,
  Clock,
} from "lucide-react";
import { formatDate } from "@/lib/utils";

interface DeviceAccess {
  device_id: string;
  enrollment_status: string;
  access_pin: string | null;
  nfc_card_number: string | null;
  provisioned_at: string | null;
  biometric_enrolled_at: string | null;
  blocked_at: string | null;
  device: { label: string } | null;
}

interface Member {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  is_active: boolean;
  created_at: string;
  access: DeviceAccess[];
}

interface Props {
  contractId: string;
  seats: number;
  contractStatus: string;
}

const STATUS_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:            { label: "Pending",           variant: "secondary" },
  provisioned:        { label: "Awaiting Enroll",   variant: "outline" },
  biometric_enrolled: { label: "Biometric Active",  variant: "default" },
  card_enrolled:      { label: "Card Active",       variant: "default" },
  fully_enrolled:     { label: "Fully Enrolled",    variant: "default" },
  blocked:            { label: "Blocked",           variant: "destructive" },
  deleted:            { label: "Removed",           variant: "secondary" },
};

function overallStatus(access: DeviceAccess[]): string {
  if (access.length === 0) return "pending";
  const statuses = access.map(a => a.enrollment_status);
  if (statuses.some(s => s === "fully_enrolled")) return "fully_enrolled";
  if (statuses.some(s => s === "biometric_enrolled")) return "biometric_enrolled";
  if (statuses.some(s => s === "card_enrolled")) return "card_enrolled";
  if (statuses.some(s => s === "blocked")) return "blocked";
  if (statuses.some(s => s === "provisioned")) return "provisioned";
  return "pending";
}

export function ContractMembersAccessSection({ contractId, seats, contractStatus }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", email: "" });
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/contracts/${contractId}/members`);
    if (res.ok) {
      const json = await res.json();
      setMembers((json.data ?? []).filter((m: Member) => m.is_active));
    }
    setLoading(false);
  }, [contractId]);

  useEffect(() => { load(); }, [load]);

  async function handleAdd() {
    if (!form.name || !form.phone) { toast.error("Name and phone are required"); return; }
    setSaving(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/members`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const json = await res.json();
      if (!res.ok) { toast.error(json.error ?? "Failed to add member"); return; }
      toast.success(`${form.name} added${contractStatus === "active" ? " — enrollment PIN sent via SMS" : ""}`);
      setDialogOpen(false);
      setForm({ name: "", phone: "", email: "" });
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function handleSendPin(member: Member) {
    setActionLoading(a => ({ ...a, [`pin_${member.id}`]: true }));
    try {
      const res = await fetch("/api/cosec/send-enrollment-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: member.id }),
      });
      const json = await res.json();
      if (res.ok) toast.success(`Enrollment PIN resent to ${member.phone}`);
      else toast.error(json.error ?? "Failed to send PIN");
    } finally {
      setActionLoading(a => ({ ...a, [`pin_${member.id}`]: false }));
    }
  }

  async function handleBlock(member: Member) {
    setActionLoading(a => ({ ...a, [`block_${member.id}`]: true }));
    try {
      const firstAccess = member.access[0];
      if (!firstAccess) { toast.error("No device access to block"); return; }
      const res = await fetch("/api/cosec/block-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_user_id: firstAccess.device_id }),
      });
      if (res.ok) { toast.success("Access blocked"); await load(); }
      else toast.error("Failed to block");
    } finally {
      setActionLoading(a => ({ ...a, [`block_${member.id}`]: false }));
    }
  }

  async function handleRemove(member: Member) {
    if (!confirm(`Remove ${member.name}? This will also block their device access.`)) return;
    setActionLoading(a => ({ ...a, [`remove_${member.id}`]: true }));
    try {
      const res = await fetch(`/api/contracts/${contractId}/members`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_id: member.id }),
      });
      if (res.ok) { toast.success(`${member.name} removed`); await load(); }
      else toast.error("Failed to remove");
    } finally {
      setActionLoading(a => ({ ...a, [`remove_${member.id}`]: false }));
    }
  }

  const activeCount = members.length;
  const canAdd = contractStatus === "active" || contractStatus === "draft";

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <Fingerprint size={16} />
              Members &amp; Access Control
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-0.5">
              {activeCount} of {seats} seats filled · Each member gets WiFi voucher + biometric/card access
            </p>
          </div>
          {canAdd && activeCount < seats && (
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <UserPlus size={14} className="mr-1.5" />
              Add Member
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="animate-spin text-muted-foreground" size={22} />
          </div>
        ) : members.length === 0 ? (
          <div className="text-center py-10 text-muted-foreground">
            <Fingerprint size={36} className="mx-auto mb-2 opacity-25" />
            <p className="font-medium text-sm">No members added yet</p>
            <p className="text-xs mt-1">
              Add members to issue WiFi vouchers and set up biometric / NFC card access.
            </p>
          </div>
        ) : (
          members.map((member) => {
            const status = overallStatus(member.access);
            const badge  = STATUS_BADGE[status] ?? STATUS_BADGE.pending;
            const isPinLoading    = actionLoading[`pin_${member.id}`];
            const isBlockLoading  = actionLoading[`block_${member.id}`];
            const isRemoveLoading = actionLoading[`remove_${member.id}`];
            const isBlocked       = status === "blocked";
            const pin = member.access[0]?.access_pin;

            return (
              <div key={member.id} className={`rounded-lg border px-4 py-3 ${isBlocked ? "opacity-60" : ""}`}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{member.name}</span>
                      <Badge variant={badge.variant} className="text-xs">{badge.label}</Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1 text-xs text-muted-foreground">
                      <span>{member.phone}</span>
                      {member.email && <span>{member.email}</span>}
                    </div>

                    {/* Per-device status */}
                    {member.access.length > 0 && (
                      <div className="flex flex-wrap gap-2 mt-2">
                        {member.access.map((au) => {
                          const s = STATUS_BADGE[au.enrollment_status] ?? STATUS_BADGE.pending;
                          const isActive = au.enrollment_status === "biometric_enrolled" || au.enrollment_status === "fully_enrolled" || au.enrollment_status === "card_enrolled";
                          return (
                            <div key={au.device_id} className="flex items-center gap-1 text-xs bg-muted/50 rounded px-2 py-0.5">
                              {isActive
                                ? <Wifi size={11} className="text-green-500" />
                                : au.enrollment_status === "blocked"
                                  ? <WifiOff size={11} className="text-red-400" />
                                  : <Clock size={11} className="text-muted-foreground" />
                              }
                              <span className="text-muted-foreground">{(au.device as { label: string } | null)?.label ?? "Device"}</span>
                              <span className={isActive ? "text-green-600 font-medium" : "text-muted-foreground"}>{s.label}</span>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* PIN hint for provisioned-but-not-enrolled */}
                    {status === "provisioned" && pin && (
                      <p className="text-xs text-amber-600 mt-1.5 flex items-center gap-1">
                        <ShieldCheck size={11} />
                        PIN: <span className="font-mono font-medium">{pin}</span> · Member must tap this at the device to enroll fingerprint
                      </p>
                    )}

                    {/* Timestamps */}
                    <div className="flex flex-wrap gap-x-3 gap-y-0 mt-1 text-xs text-muted-foreground">
                      {member.access[0]?.provisioned_at && (
                        <span>Provisioned {formatDate(member.access[0].provisioned_at)}</span>
                      )}
                      {member.access[0]?.biometric_enrolled_at && (
                        <span className="flex items-center gap-0.5">
                          <Fingerprint size={10} /> Enrolled {formatDate(member.access[0].biometric_enrolled_at)}
                        </span>
                      )}
                      {member.access[0]?.nfc_card_number && (
                        <span className="flex items-center gap-0.5">
                          <CreditCard size={10} /> {member.access[0].nfc_card_number}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    {status === "provisioned" && (
                      <Button
                        size="sm" variant="outline" className="text-xs h-7"
                        onClick={() => handleSendPin(member)}
                        disabled={isPinLoading}
                        title="Resend enrollment PIN"
                      >
                        {isPinLoading
                          ? <Loader2 size={13} className="animate-spin" />
                          : <><Send size={12} className="mr-1" />Resend PIN</>
                        }
                      </Button>
                    )}
                    {!isBlocked && status !== "provisioned" && status !== "pending" && (
                      <Button
                        size="sm" variant="ghost" className="text-xs h-7 text-red-600 hover:text-red-700"
                        onClick={() => handleBlock(member)}
                        disabled={isBlockLoading}
                        title="Block device access"
                      >
                        {isBlockLoading ? <Loader2 size={13} className="animate-spin" /> : <ShieldOff size={13} />}
                      </Button>
                    )}
                    <Button
                      size="sm" variant="ghost" className="text-xs h-7 text-muted-foreground"
                      onClick={() => handleRemove(member)}
                      disabled={isRemoveLoading}
                      title="Remove member"
                    >
                      {isRemoveLoading ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </Button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </CardContent>

      {/* Add member dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Member</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label>Full Name <span className="text-red-500">*</span></Label>
              <Input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Ravi Kumar"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Phone <span className="text-red-500">*</span></Label>
              <Input
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                placeholder="9876543210"
                type="tel"
              />
              <p className="text-xs text-muted-foreground">Enrollment PIN will be sent to this number via SMS</p>
            </div>
            <div className="space-y-1.5">
              <Label>Email <span className="text-muted-foreground text-xs">(optional)</span></Label>
              <Input
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                placeholder="ravi@company.com"
                type="email"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={saving}>
              {saving && <Loader2 size={14} className="animate-spin mr-2" />}
              Add Member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

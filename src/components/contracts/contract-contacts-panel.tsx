"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Plus,
  Edit2,
  Trash2,
  User,
  Phone,
  Mail,
  Briefcase,
  X,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Fingerprint,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

/* ------------------------------------------------------------------ */
/*  Types & constants                                                  */
/* ------------------------------------------------------------------ */

interface ContractContact {
  id: string;
  contract_id: string;
  full_name: string;
  designation: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  contact_role: string;
  notes: string | null;
  is_active: boolean;
  source_member_id: string | null;
  created_at: string;
  updated_at: string;
}

const CONTACT_ROLES: { value: string; label: string; color: string }[] = [
  { value: "primary", label: "Primary", color: "bg-blue-100 text-blue-800" },
  { value: "finance", label: "Finance", color: "bg-green-100 text-green-800" },
  { value: "occupant", label: "Occupant", color: "bg-purple-100 text-purple-800" },
  { value: "signatory", label: "Signatory", color: "bg-amber-100 text-amber-800" },
  { value: "escalation", label: "Escalation", color: "bg-red-100 text-red-800" },
  { value: "it", label: "IT", color: "bg-cyan-100 text-cyan-800" },
  { value: "general", label: "General", color: "bg-gray-100 text-gray-800" },
];

function roleBadge(role: string) {
  const r = CONTACT_ROLES.find((cr) => cr.value === role);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        r?.color || "bg-gray-100 text-gray-800"
      }`}
    >
      {r?.label || role}
    </span>
  );
}

const emptyForm = {
  full_name: "",
  designation: "",
  email: "",
  phone: "",
  mobile: "",
  contact_role: "general",
  notes: "",
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ContractContactsPanel({
  contractId,
  leadId,
}: {
  contractId: string;
  leadId?: string;
}) {
  const [contacts, setContacts] = useState<ContractContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [importing, setImporting] = useState(false);

  const fetchContacts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/contracts/${contractId}/contacts`);
      const json = await res.json();
      setContacts(json.data || []);
    } catch {
      toast.error("Failed to load contacts");
    } finally {
      setLoading(false);
    }
  }, [contractId]);

  useEffect(() => {
    fetchContacts();
  }, [fetchContacts]);

  /* ---- Import from lead ---- */
  const importFromLead = async () => {
    if (!leadId) return;
    setImporting(true);
    try {
      const res = await fetch(`/api/leads/${leadId}/contacts`);
      const json = await res.json();
      const leadContacts = json.data || [];
      if (leadContacts.length === 0) {
        toast.info("No contacts found on the lead to import");
        setImporting(false);
        return;
      }
      let imported = 0;
      for (const lc of leadContacts) {
        const addRes = await fetch(`/api/contracts/${contractId}/contacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            full_name: lc.full_name,
            designation: lc.designation,
            email: lc.email,
            phone: lc.phone,
            mobile: lc.mobile,
            contact_role: lc.contact_role,
            notes: lc.notes,
          }),
        });
        if (addRes.ok) imported++;
      }
      toast.success(`Imported ${imported} contact(s) from lead`);
      fetchContacts();
    } catch {
      toast.error("Failed to import contacts from lead");
    } finally {
      setImporting(false);
    }
  };

  /* ---- Add / Edit ---- */
  const openAdd = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEdit = (c: ContractContact) => {
    setEditingId(c.id);
    setForm({
      full_name: c.full_name,
      designation: c.designation || "",
      email: c.email || "",
      phone: c.phone || "",
      mobile: c.mobile || "",
      contact_role: c.contact_role,
      notes: c.notes || "",
    });
    setShowForm(true);
  };

  const editingContact = editingId ? contacts.find((c) => c.id === editingId) : null;
  const isEditingMemberLinked = !!editingContact?.source_member_id;

  const cancelForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleSave = async () => {
    if (!form.full_name.trim()) {
      toast.error("Full name is required");
      return;
    }
    setSaving(true);
    try {
      if (editingId) {
        const res = await fetch(`/api/contracts/${contractId}/contacts`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contact_id: editingId, ...form }),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        toast.success("Contact updated");
      } else {
        const res = await fetch(`/api/contracts/${contractId}/contacts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        if (!res.ok) throw new Error((await res.json()).error);
        toast.success("Contact added");
      }
      cancelForm();
      fetchContacts();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save contact");
    } finally {
      setSaving(false);
    }
  };

  /* ---- Delete ---- */
  const handleDelete = async (contactId: string) => {
    if (!confirm("Remove this contact?")) return;
    try {
      const res = await fetch(`/api/contracts/${contractId}/contacts`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId }),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      toast.success("Contact removed");
      fetchContacts();
    } catch {
      toast.error("Failed to remove contact");
    }
  };

  /* ---- Render ---- */
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <button
          className="flex items-center gap-2 text-left"
          onClick={() => setExpanded((e) => !e)}
        >
          <CardTitle className="text-base">
            Contract Contacts
            {contacts.length > 0 && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                ({contacts.length})
              </span>
            )}
          </CardTitle>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </button>
        <div className="flex gap-2">
          {leadId && contacts.length === 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={importFromLead}
              disabled={importing}
            >
              <Copy className="mr-1 h-3.5 w-3.5" />
              {importing ? "Importing..." : "Import from Lead"}
            </Button>
          )}
          <Button size="sm" variant="outline" onClick={openAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add
          </Button>
        </div>
      </CardHeader>

      {expanded && (
        <CardContent className="pt-0 space-y-3">
          {/* Inline form for add / edit */}
          {showForm && (
            <div className="rounded-lg border bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-medium">
                {editingId ? "Edit Contact" : "New Contact"}
              </p>
              {isEditingMemberLinked && (
                <p className="text-xs text-muted-foreground bg-muted/60 rounded px-2 py-1.5">
                  Name, email, and phone come from Members &amp; Access Control — edit them there.
                  Designation, role, and notes are specific to this contact entry.
                </p>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">
                    Full Name <span className="text-red-500">*</span>
                  </Label>
                  <Input
                    value={form.full_name}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, full_name: e.target.value }))
                    }
                    placeholder="John Doe"
                    className="mt-1"
                    disabled={isEditingMemberLinked}
                  />
                </div>
                <div>
                  <Label className="text-xs">Designation</Label>
                  <Input
                    value={form.designation}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, designation: e.target.value }))
                    }
                    placeholder="CFO, Office Manager..."
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Email</Label>
                  <Input
                    type="email"
                    value={form.email}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, email: e.target.value }))
                    }
                    placeholder="email@example.com"
                    className="mt-1"
                    disabled={isEditingMemberLinked}
                  />
                </div>
                <div>
                  <Label className="text-xs">Phone</Label>
                  <Input
                    value={form.phone}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, phone: e.target.value }))
                    }
                    placeholder="+91 ..."
                    className="mt-1"
                    disabled={isEditingMemberLinked}
                  />
                </div>
                <div>
                  <Label className="text-xs">Mobile</Label>
                  <Input
                    value={form.mobile}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, mobile: e.target.value }))
                    }
                    placeholder="+91 ..."
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">Role</Label>
                  <Select
                    value={form.contact_role}
                    onValueChange={(v) =>
                      setForm((f) => ({ ...f, contact_role: v }))
                    }
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {CONTACT_ROLES.map((r) => (
                        <SelectItem key={r.value} value={r.value}>
                          {r.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-xs">Notes</Label>
                <Textarea
                  value={form.notes}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, notes: e.target.value }))
                  }
                  rows={2}
                  placeholder="Optional notes..."
                  className="mt-1"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={cancelForm}>
                  <X className="mr-1 h-3.5 w-3.5" />
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Check className="mr-1 h-3.5 w-3.5" />
                  {saving ? "Saving..." : editingId ? "Update" : "Add Contact"}
                </Button>
              </div>
            </div>
          )}

          {/* Contact list */}
          {loading ? (
            <p className="text-sm text-muted-foreground py-2">Loading...</p>
          ) : contacts.length === 0 && !showForm ? (
            <p className="text-sm text-muted-foreground py-2">
              No contacts yet.{" "}
              {leadId
                ? 'Click "Import from Lead" to copy lead contacts, or "Add" to create new ones.'
                : 'Click "Add" to create one.'}
            </p>
          ) : (
            <div className="divide-y">
              {contacts.map((c) => (
                <div
                  key={c.id}
                  className={`flex items-start justify-between gap-3 py-3 first:pt-0 ${
                    !c.is_active ? "opacity-50" : ""
                  }`}
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium">{c.full_name}</span>
                      {roleBadge(c.contact_role)}
                      {c.source_member_id && (
                        <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-teal-100 text-teal-800">
                          <Fingerprint className="h-3 w-3" />
                          From Members
                        </span>
                      )}
                      {!c.is_active && (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider bg-gray-200 text-gray-600">
                          Removed member
                        </span>
                      )}
                      {c.designation && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Briefcase className="h-3 w-3" />
                          {c.designation}
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
                      {c.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="h-3 w-3" />
                          {c.email}
                        </span>
                      )}
                      {c.phone && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {c.phone}
                        </span>
                      )}
                      {c.mobile && (
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" />
                          {c.mobile}
                        </span>
                      )}
                    </div>
                    {c.notes && (
                      <p className="text-xs text-muted-foreground italic mt-0.5">
                        {c.notes}
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => openEdit(c)}
                    >
                      <Edit2 className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 text-destructive hover:text-destructive disabled:opacity-30"
                      onClick={() => handleDelete(c.id)}
                      disabled={!!c.source_member_id}
                      title={c.source_member_id ? "Remove this person from Members & Access Control instead" : undefined}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}

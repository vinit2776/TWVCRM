"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import {
  Loader2,
  ExternalLink,
  Monitor,
  Globe,
  User,
  Clock,
  MessageSquare,
  Send,
} from "lucide-react";
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_COLORS,
  TICKET_TYPE_LABELS,
  TICKET_TYPE_COLORS,
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_PRIORITY_COLORS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";

interface TicketNote {
  id: string;
  note: string;
  created_at: string;
  author: { id: string; full_name: string; email: string } | null;
}

interface TicketDetail {
  id: string;
  ticket_number: string;
  subject: string;
  description: string | null;
  type: string;
  priority: string;
  status: string;
  page_url: string | null;
  user_agent: string | null;
  screen_resolution: string | null;
  screenshot_path: string | null;
  screenshot_url: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  reporter: { id: string; full_name: string; email: string; role: string } | null;
  assignee: { id: string; full_name: string; email: string } | null;
  assigned_to: string | null;
  notes: TicketNote[];
}

interface TeamMember {
  id: string;
  full_name: string;
  email: string;
}

interface TicketDetailDialogProps {
  ticketId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpdated?: () => void;
}

export function TicketDetailDialog({
  ticketId,
  open,
  onOpenChange,
  onUpdated,
}: TicketDetailDialogProps) {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);

  // Editable fields
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [newNote, setNewNote] = useState("");

  // Fetch ticket detail
  useEffect(() => {
    if (!open || !ticketId) return;

    async function fetchTicket() {
      setLoading(true);
      try {
        const res = await fetch(`/api/support-tickets/${ticketId}`);
        if (!res.ok) throw new Error("Failed to fetch ticket");
        const { data } = await res.json();
        setTicket(data);
        setStatus(data.status);
        setPriority(data.priority);
        setAssignedTo(data.assigned_to || "");
      } catch {
        toast.error("Failed to load ticket details");
        onOpenChange(false);
      } finally {
        setLoading(false);
      }
    }

    async function fetchTeam() {
      try {
        const res = await fetch("/api/team");
        if (res.ok) {
          const { data } = await res.json();
          setTeamMembers(
            (data || []).map((u: { id: string; full_name: string; email: string }) => ({
              id: u.id,
              full_name: u.full_name,
              email: u.email,
            }))
          );
        }
      } catch {
        // Silent fail — team dropdown just won't populate
      }
    }

    fetchTicket();
    fetchTeam();
  }, [open, ticketId, onOpenChange]);

  async function handleSave() {
    if (!ticketId) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/support-tickets/${ticketId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          priority,
          assigned_to: assignedTo || "",
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to update");
      }

      const { data } = await res.json();
      setTicket((prev) => (prev ? { ...prev, ...data, notes: prev.notes } : prev));
      toast.success("Ticket updated");
      onUpdated?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update ticket");
    } finally {
      setSaving(false);
    }
  }

  async function handleAddNote() {
    if (!ticketId || !newNote.trim()) return;
    setAddingNote(true);
    try {
      const res = await fetch(`/api/support-tickets/${ticketId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: newNote.trim() }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add note");
      }

      const { data: note } = await res.json();
      setTicket((prev) =>
        prev ? { ...prev, notes: [...prev.notes, note] } : prev
      );
      setNewNote("");
      toast.success("Note added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add note");
    } finally {
      setAddingNote(false);
    }
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleString("en-IN", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        {loading || !ticket ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-muted-foreground">
                  {ticket.ticket_number}
                </span>
                <Badge className={cn("text-xs", TICKET_TYPE_COLORS[ticket.type])}>
                  {TICKET_TYPE_LABELS[ticket.type]}
                </Badge>
              </div>
              <DialogTitle className="text-lg">{ticket.subject}</DialogTitle>
            </DialogHeader>

            <div className="space-y-5">
              {/* Description */}
              {ticket.description && (
                <div className="rounded-md bg-muted/50 p-3 text-sm whitespace-pre-wrap">
                  {ticket.description}
                </div>
              )}

              {/* Screenshot */}
              {ticket.screenshot_url && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Screenshot</Label>
                  <a
                    href={ticket.screenshot_url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <img
                      src={ticket.screenshot_url}
                      alt="Ticket screenshot"
                      className="rounded-md border max-h-64 object-contain w-full bg-muted cursor-pointer hover:opacity-90 transition-opacity"
                    />
                  </a>
                </div>
              )}

              {/* Context info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                {ticket.page_url && (
                  <div className="flex items-start gap-2">
                    <Globe className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Page URL</p>
                      <a
                        href={ticket.page_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline truncate block"
                      >
                        {ticket.page_url.replace(/^https?:\/\/[^/]+/, "")}
                        <ExternalLink className="inline h-3 w-3 ml-1" />
                      </a>
                    </div>
                  </div>
                )}
                {ticket.screen_resolution && (
                  <div className="flex items-start gap-2">
                    <Monitor className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-xs text-muted-foreground">Screen</p>
                      <p>{ticket.screen_resolution}</p>
                    </div>
                  </div>
                )}
                {ticket.reporter && (
                  <div className="flex items-start gap-2">
                    <User className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-xs text-muted-foreground">Reporter</p>
                      <p>{ticket.reporter.full_name}</p>
                      <p className="text-xs text-muted-foreground">{ticket.reporter.email}</p>
                    </div>
                  </div>
                )}
                <div className="flex items-start gap-2">
                  <Clock className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                  <div>
                    <p className="text-xs text-muted-foreground">Created</p>
                    <p>{formatDate(ticket.created_at)}</p>
                  </div>
                </div>
              </div>

              {ticket.user_agent && (
                <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2 break-all">
                  <span className="font-medium">User Agent:</span> {ticket.user_agent}
                </div>
              )}

              <Separator />

              {/* Admin Controls */}
              <div className="space-y-3">
                <p className="text-sm font-medium">Manage Ticket</p>
                <div className="grid grid-cols-3 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Status</Label>
                    <Select value={status} onValueChange={setStatus}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TICKET_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {TICKET_STATUS_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Priority</Label>
                    <Select value={priority} onValueChange={setPriority}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_PRIORITIES.map((p) => (
                          <SelectItem key={p} value={p}>
                            {TASK_PRIORITY_LABELS[p]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Assigned To</Label>
                    <Select value={assignedTo} onValueChange={setAssignedTo}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Unassigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">Unassigned</SelectItem>
                        {teamMembers.map((m) => (
                          <SelectItem key={m.id} value={m.id}>
                            {m.full_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button size="sm" onClick={handleSave} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-3 w-3 animate-spin" />}
                    Save Changes
                  </Button>
                </div>
              </div>

              <Separator />

              {/* Notes */}
              <div className="space-y-3">
                <p className="text-sm font-medium flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Notes ({ticket.notes.length})
                </p>

                {ticket.notes.length > 0 && (
                  <div className="space-y-3 max-h-60 overflow-y-auto">
                    {ticket.notes.map((note) => (
                      <div
                        key={note.id}
                        className="rounded-md border p-3 text-sm space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium">
                            {note.author?.full_name || "Unknown"}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {formatDate(note.created_at)}
                          </p>
                        </div>
                        <p className="text-sm whitespace-pre-wrap">{note.note}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Add note */}
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Add a note..."
                    value={newNote}
                    onChange={(e) => setNewNote(e.target.value)}
                    rows={2}
                    className="text-sm"
                  />
                  <Button
                    size="icon"
                    className="shrink-0 self-end"
                    onClick={handleAddNote}
                    disabled={addingNote || !newNote.trim()}
                  >
                    {addingNote ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Send className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

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
  CheckCircle2,
  RotateCcw,
  Paperclip,
  Upload,
  FileText,
  Image as ImageIcon,
} from "lucide-react";
import {
  TICKET_TYPE_LABELS,
  TICKET_TYPE_COLORS,
  TICKET_STATUS_LABELS,
  TICKET_STATUS_COLORS,
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

interface Attachment {
  path: string;
  name: string;
  uploaded_at: string;
  url: string | null;
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
  build_approved_at: string | null;
  build_approved_notes: string | null;
  created_at: string;
  updated_at: string;
  reporter: { id: string; full_name: string; email: string; role: string } | null;
  assignee: { id: string; full_name: string; email: string } | null;
  assigned_to: string | null;
  notes: TicketNote[];
  attachments_with_urls?: Attachment[];
}

interface MyTicketDetailDialogProps {
  ticketId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function MyTicketDetailDialog({
  ticketId,
  open,
  onOpenChange,
}: MyTicketDetailDialogProps) {
  const [loading, setLoading] = useState(false);
  const [addingNote, setAddingNote] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [ticket, setTicket] = useState<TicketDetail | null>(null);
  const [newNote, setNewNote] = useState("");

  useEffect(() => {
    if (!open || !ticketId) return;

    async function fetchTicket() {
      setLoading(true);
      try {
        const res = await fetch(`/api/support-tickets/${ticketId}`);
        if (!res.ok) throw new Error("Failed to fetch ticket");
        const { data } = await res.json();
        setTicket(data);
      } catch {
        toast.error("Failed to load ticket details");
        onOpenChange(false);
      } finally {
        setLoading(false);
      }
    }

    fetchTicket();
  }, [open, ticketId, onOpenChange]);

  async function handleReopen() {
    if (!ticketId) return;
    setReopening(true);
    try {
      const res = await fetch(`/api/support-tickets/${ticketId}/reopen`, {
        method: "POST",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to reopen ticket");
      }

      const { data: updated } = await res.json();
      setTicket((prev) => (prev ? { ...prev, ...updated, notes: prev.notes } : prev));
      toast.success("Ticket reopened");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reopen ticket");
    } finally {
      setReopening(false);
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
        throw new Error(err.error || "Failed to send reply");
      }

      const { data: note } = await res.json();
      setTicket((prev) =>
        prev ? { ...prev, notes: [...prev.notes, note] } : prev
      );
      setNewNote("");
      toast.success("Reply sent");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send reply");
    } finally {
      setAddingNote(false);
    }
  }

  async function handleAttachFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !ticketId) return;
    if (file.size > 10 * 1024 * 1024) { toast.error("File must be under 10MB"); return; }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/support-tickets/${ticketId}/screenshot`, { method: "POST", body: formData });
      if (!res.ok) {
        const err = await res.json().catch(() => null);
        throw new Error(err?.error || "Upload failed");
      }
      toast.success("Attachment uploaded");
      // Re-fetch ticket to get updated attachments with signed URLs
      const ticketRes = await fetch(`/api/support-tickets/${ticketId}`);
      if (ticketRes.ok) {
        const { data } = await ticketRes.json();
        setTicket(data);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      e.target.value = "";
    }
  }

  function formatDate(date: string) {
    return new Date(date).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
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
          <>
            <DialogHeader>
              <DialogTitle>Ticket Details</DialogTitle>
            </DialogHeader>
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-muted-foreground">
                  {ticket.ticket_number}
                </span>
                <Badge className={cn("text-xs", TICKET_TYPE_COLORS[ticket.type])}>
                  {TICKET_TYPE_LABELS[ticket.type]}
                </Badge>
                <Badge
                  variant="secondary"
                  className={cn("text-xs", TICKET_STATUS_COLORS[ticket.status])}
                >
                  {TICKET_STATUS_LABELS[ticket.status]}
                </Badge>
                <Badge
                  variant="secondary"
                  className={cn("text-xs", TASK_PRIORITY_COLORS[ticket.priority])}
                >
                  {TASK_PRIORITY_LABELS[ticket.priority]}
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

              {/* Attachments */}
              {((ticket.attachments_with_urls && ticket.attachments_with_urls.length > 0) || ticket.screenshot_url) && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
                    <Paperclip className="h-3.5 w-3.5" />
                    Attachments ({ticket.attachments_with_urls?.length || (ticket.screenshot_url ? 1 : 0)})
                  </Label>
                  <div className="grid gap-2">
                    {ticket.attachments_with_urls && ticket.attachments_with_urls.length > 0 ? (
                      ticket.attachments_with_urls.map((att, i) => (
                        <a key={i} href={att.url || "#"} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-md border p-2 hover:bg-muted/50 transition-colors">
                          {att.name?.match(/\.(png|jpg|jpeg|gif|webp)$/i) ? (
                            <ImageIcon className="h-4 w-4 text-muted-foreground shrink-0" />
                          ) : (
                            <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                          )}
                          <span className="text-sm truncate flex-1">{att.name || "attachment"}</span>
                          <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                        </a>
                      ))
                    ) : ticket.screenshot_url ? (
                      <a href={ticket.screenshot_url} target="_blank" rel="noopener noreferrer">
                        <img src={ticket.screenshot_url} alt="Screenshot" className="rounded-md border max-h-48 object-contain w-full bg-muted cursor-pointer hover:opacity-90 transition-opacity" />
                      </a>
                    ) : null}
                  </div>
                </div>
              )}

              {/* Add attachment (if ticket not closed) */}
              {ticket.status !== "closed" && (
                <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground hover:bg-muted/50 transition-colors">
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  <span>{uploading ? "Uploading..." : "Attach a file (image, PDF, document — max 10MB)"}</span>
                  <input type="file" accept="image/*,.pdf,.doc,.docx" className="hidden" onChange={handleAttachFile} disabled={uploading} />
                </label>
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
                      <p className="text-xs text-muted-foreground">Reported by</p>
                      <p>{ticket.reporter.full_name}</p>
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

              {/* Build Approved — read-only banner */}
              {ticket.status === "build_approved" && ticket.build_approved_at && (
                <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-emerald-700 flex-shrink-0" />
                    <p className="text-sm font-semibold text-emerald-800">Build Approved</p>
                    <span className="text-xs text-emerald-600 ml-auto">
                      {formatDate(ticket.build_approved_at)}
                    </span>
                  </div>
                  {ticket.build_approved_notes && (
                    <p className="text-sm text-emerald-900 whitespace-pre-wrap pl-6">
                      {ticket.build_approved_notes}
                    </p>
                  )}
                </div>
              )}

              {/* Reopen — shown only for resolved / closed tickets */}
              {(ticket.status === "resolved" || ticket.status === "closed") && (
                <div className="rounded-lg border border-muted bg-muted/30 p-3 flex items-center justify-between gap-3">
                  <p className="text-sm text-muted-foreground">
                    This ticket is {ticket.status}. Is the issue still occurring?
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={handleReopen}
                    disabled={reopening}
                    className="shrink-0"
                  >
                    {reopening ? (
                      <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-2 h-3 w-3" />
                    )}
                    Reopen Ticket
                  </Button>
                </div>
              )}

              {/* Notes / Replies thread */}
              <div className="space-y-3">
                <p className="text-sm font-medium flex items-center gap-2">
                  <MessageSquare className="h-4 w-4" />
                  Replies ({ticket.notes.length})
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
                            {note.author?.full_name || "Support Team"}
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

                {/* Reply input */}
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Add a clarification or reply..."
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

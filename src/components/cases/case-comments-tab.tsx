"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useCaseComments } from "@/hooks/use-cases";
import { toast } from "sonner";
import { Loader2, MessageSquare, Send, User } from "lucide-react";
import { formatRelativeDate } from "@/lib/utils";

interface CaseCommentsTabProps {
  caseId: string;
}

export function CaseCommentsTab({ caseId }: CaseCommentsTabProps) {
  const { data: comments, loading, refetch } = useCaseComments(caseId);
  const [comment, setComment] = useState("");
  const [isInternal, setIsInternal] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/cases/${caseId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: comment.trim(), is_internal: isInternal }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to add comment");
      }
      toast.success("Comment added");
      setComment("");
      refetch();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add comment");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Add Comment */}
      <div className="border rounded-lg p-4 space-y-3">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Add a comment..."
          rows={3}
        />
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Switch
              id="internal"
              checked={isInternal}
              onCheckedChange={setIsInternal}
            />
            <Label htmlFor="internal" className="text-sm cursor-pointer">
              {isInternal ? "Internal note" : "External (visible to aggregator)"}
            </Label>
          </div>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={submitting || !comment.trim()}
          >
            {submitting ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            Comment
          </Button>
        </div>
      </div>

      {/* Comments List */}
      {loading ? (
        <div className="text-center py-8 text-muted-foreground">Loading comments...</div>
      ) : comments.length === 0 ? (
        <div className="text-center py-8 text-muted-foreground text-sm">
          <MessageSquare className="h-8 w-8 mx-auto mb-2 opacity-50" />
          No comments yet.
        </div>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => (
            <div
              key={c.id}
              className="border rounded-lg p-4 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm">
                  <User className="h-4 w-4 text-muted-foreground" />
                  <span className="font-medium">
                    {(c as unknown as Record<string, unknown>).user
                      ? ((c as unknown as Record<string, unknown>).user as { full_name: string }).full_name
                      : "System"}
                  </span>
                  {c.is_internal && (
                    <Badge variant="outline" className="text-xs bg-yellow-50 text-yellow-700">Internal</Badge>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {formatRelativeDate(c.created_at)}
                </span>
              </div>
              <p className="text-sm whitespace-pre-wrap">{c.comment}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

"use client";

import Link from "next/link";
import { ThumbsUp, ThumbsDown } from "lucide-react";
import { cn } from "@/lib/utils";

export interface HelpChatMessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: { sectionId: string; title: string }[];
  isError?: boolean;
  /** Set only when the backend successfully logged this exchange — feedback has nothing to attach to otherwise. */
  interactionId?: string | null;
  feedback?: "helpful" | "not_helpful" | null;
}

interface HelpChatMessageProps {
  message: HelpChatMessageData;
  onFeedback?: (messageId: string, interactionId: string, feedback: "helpful" | "not_helpful") => void;
}

export function HelpChatMessage({ message, onFeedback }: HelpChatMessageProps) {
  const isUser = message.role === "user";
  const canRate = !isUser && !message.isError && !!message.interactionId && !!onFeedback;

  return (
    <div className={cn("flex flex-col gap-1", isUser ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : message.isError
              ? "rounded-bl-sm border border-destructive/20 bg-destructive/10 text-destructive"
              : "rounded-bl-sm bg-muted text-foreground"
        )}
      >
        {message.content}
        {message.sources && message.sources.length > 0 && (
          <div className="mt-2 flex flex-col gap-1 border-t border-current/10 pt-2">
            {message.sources.map((source) => (
              <Link
                key={source.sectionId}
                href={`/help#${source.sectionId}`}
                className="text-xs font-medium text-primary hover:underline"
              >
                📖 Full guide — {source.title}
              </Link>
            ))}
          </div>
        )}
      </div>

      {canRate && (
        <div className="flex items-center gap-2 px-1">
          {message.feedback ? (
            <span className="text-xs text-muted-foreground">
              {message.feedback === "helpful" ? "Thanks for the feedback 👍" : "Thanks — noted 👎"}
            </span>
          ) : (
            <>
              <span className="text-xs text-muted-foreground">Helpful?</span>
              <button
                type="button"
                onClick={() => onFeedback!(message.id, message.interactionId!, "helpful")}
                className="rounded p-0.5 text-muted-foreground hover:text-accent"
                title="This was helpful"
              >
                <ThumbsUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => onFeedback!(message.id, message.interactionId!, "not_helpful")}
                className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                title="This wasn't helpful"
              >
                <ThumbsDown className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

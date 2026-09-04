"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";

export interface HelpChatMessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
  sources?: { sectionId: string; title: string }[];
  isError?: boolean;
}

export function HelpChatMessage({ message }: { message: HelpChatMessageData }) {
  const isUser = message.role === "user";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
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
    </div>
  );
}

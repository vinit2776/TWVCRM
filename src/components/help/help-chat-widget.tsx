"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { MessageCircle, X, Send, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCurrentUser } from "@/providers/current-user-provider";
import { HELP_CONTENT } from "@/lib/help-content";
import { USER_ROLE_LABELS } from "@/lib/constants";
import { HelpChatMessage, type HelpChatMessageData } from "./help-chat-message";

const STARTER_QUESTIONS = HELP_CONTENT.globalFaqs.slice(0, 3).map((f) => f.question);

// Kept short — this is a Q&A assistant, not a long-running conversation, and
// it must stay well under the API route's own history cap (6 messages).
const MAX_HISTORY_SENT = 6;

export function HelpChatWidget() {
  const { user } = useCurrentUser();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<HelpChatMessageData[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  async function sendQuestion(question: string) {
    const trimmed = question.trim();
    if (!trimmed || sending) return;

    // Only real, successful exchanges go back as history — an error bubble
    // isn't a valid conversational turn and would break the strict
    // user/assistant alternation the API route expects.
    const history = messages
      .filter((m) => !m.isError)
      .slice(-MAX_HISTORY_SENT)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: "user", content: trimmed }]);
    setInput("");
    setSending(true);

    try {
      const res = await fetch("/api/help-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: trimmed, history, page: pathname }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: data.error || "Something went wrong — try again in a moment.",
            isError: true,
          },
        ]);
        return;
      }

      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: data.answer,
          sources: data.sources,
          interactionId: data.interactionId ?? null,
          feedback: null,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: "Couldn't reach the assistant — check your connection and try again.",
          isError: true,
        },
      ]);
    } finally {
      setSending(false);
    }
  }

  async function handleFeedback(
    messageId: string,
    interactionId: string,
    feedback: "helpful" | "not_helpful"
  ) {
    // Optimistic — this is a low-stakes analytics signal, not something
    // worth blocking or rolling back the UI over if the request fails.
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, feedback } : m)));
    try {
      await fetch("/api/help-chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interactionId, feedback }),
      });
    } catch {
      // Silent — feedback is best-effort telemetry, not core functionality.
    }
  }

  const roleLabel = user?.role ? USER_ROLE_LABELS[user.role] ?? user.role : "";

  return (
    <>
      <Button
        onClick={() => setOpen((v) => !v)}
        size="icon"
        className="fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full shadow-lg"
        title="WorkVilla Assistant"
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
      </Button>

      {open && (
        <div className="fixed bottom-24 right-6 z-50 flex h-[480px] w-[340px] max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl">
          <div className="flex items-center gap-2 bg-primary px-4 py-3 text-primary-foreground">
            <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/20 text-sm">
              💬
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight">WorkVilla Assistant</p>
              {roleLabel && (
                <p className="text-xs leading-tight text-primary-foreground/80">Signed in as {roleLabel}</p>
              )}
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-3">
            {messages.length === 0 && (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Ask me how to do anything in the CRM — I&apos;ll answer based on what your role can see.
                </p>
                {STARTER_QUESTIONS.length > 0 && (
                  <div className="flex flex-col gap-1.5">
                    {STARTER_QUESTIONS.map((q) => (
                      <button
                        key={q}
                        type="button"
                        onClick={() => sendQuestion(q)}
                        className="rounded-lg border bg-secondary/50 px-3 py-2 text-left text-xs hover:bg-secondary"
                      >
                        {q}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {messages.map((message) => (
              <HelpChatMessage key={message.id} message={message} onFeedback={handleFeedback} />
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="flex items-center gap-1.5 rounded-2xl rounded-bl-sm bg-muted px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Thinking…
                </div>
              </div>
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              sendQuestion(input);
            }}
            className="flex items-center gap-2 border-t p-2.5"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question…"
              disabled={sending}
              className="flex-1 rounded-full border bg-muted/50 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring disabled:opacity-60"
            />
            <Button
              type="submit"
              size="icon"
              className="h-9 w-9 shrink-0 rounded-full"
              disabled={sending || !input.trim()}
            >
              <Send className="h-4 w-4" />
            </Button>
          </form>
        </div>
      )}
    </>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, MessageSquare, Plus, Send } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface Msg {
  id?: string;
  role: "user" | "assistant";
  content: string;
  error?: string | null;
}

interface Thread {
  id: string;
  title: string | null;
  provider: string | null;
  model: string | null;
  updated_at: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  claude_code: "Claude · signed in",
  anthropic: "Claude · API key",
  google: "Gemini",
  openai: "OpenAI",
  ollama: "Local",
};

export default function ChatPage() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [meta, setMeta] = useState<{ provider: string; model: string } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const loadThreads = useCallback(async () => {
    const res = await fetch("/api/chat");
    if (res.ok) setThreads((await res.json()).conversations ?? []);
  }, []);

  useEffect(() => {
    loadThreads();
  }, [loadThreads]);

  // Keep the newest turn in view. A conversation that answers below the fold
  // reads as one that did not answer.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function openThread(id: string) {
    setConversationId(id);
    setBusy(true);
    const res = await fetch(`/api/chat?conversation_id=${id}`);
    if (res.ok) setMessages((await res.json()).messages ?? []);
    setBusy(false);
  }

  function newThread() {
    setConversationId(null);
    setMessages([]);
    setMeta(null);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    // Shown immediately: the round trip can take seconds on a local model, and
    // an input that empties with nothing appearing looks like a dropped message.
    setMessages((m) => [...m, { role: "user", content: message }]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, conversation_id: conversationId }),
      });
      const data = await res.json();
      setConversationId(data.conversation_id ?? conversationId);
      setMeta({ provider: data.provider, model: data.model });
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.reply ?? "", error: data.error },
      ]);
      loadThreads();
    } catch (err) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "", error: (err as Error).message },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-6rem)] gap-4">
      <aside className="hidden w-56 shrink-0 flex-col gap-2 lg:flex">
        <Button variant="outline" size="sm" onClick={newThread}>
          <Plus className="h-4 w-4" /> New conversation
        </Button>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto">
          {threads.map((t) => (
            <button
              key={t.id}
              onClick={() => openThread(t.id)}
              className={cn(
                "w-full rounded-md border p-2 text-left text-xs",
                conversationId === t.id ? "border-primary bg-primary/5" : "hover:bg-accent"
              )}
            >
              <span className="line-clamp-2">{t.title ?? "Untitled"}</span>
              <span className="mt-1 block text-[10px] text-muted-foreground">
                {PROVIDER_LABEL[t.provider ?? ""] ?? t.provider} ·{" "}
                {new Date(t.updated_at).toLocaleDateString()}
              </span>
            </button>
          ))}
          {threads.length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">No conversations yet.</p>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="mb-3 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Chat</h1>
          {meta && (
            <Badge variant="outline">
              {PROVIDER_LABEL[meta.provider] ?? meta.provider} · {meta.model}
            </Badge>
          )}
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          {messages.length === 0 && !busy && (
            <Card>
              <CardContent className="space-y-2 p-6 text-sm text-muted-foreground">
                <p className="flex items-center gap-2 text-foreground">
                  <MessageSquare className="h-4 w-4" /> Ask about your own money.
                </p>
                <p>
                  It sees your balances, the last 90 days of spending, your goals,
                  recurring bills and your floors — and answers from those rather
                  than guessing. It cannot move money or change settings.
                </p>
                <p className="text-xs">
                  Try: &ldquo;where did the grocery spend go this month?&rdquo; ·
                  &ldquo;how much headroom is left above my liquid floor?&rdquo; ·
                  &ldquo;which subscriptions look wrong?&rdquo;
                </p>
              </CardContent>
            </Card>
          )}

          {messages.map((m, i) => (
            <div
              key={m.id ?? i}
              className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}
            >
              <div
                className={cn(
                  "max-w-[85%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
                  m.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : m.error
                      ? "border border-destructive/40 bg-destructive/5"
                      : "border bg-muted/40"
                )}
              >
                {m.content}
                {m.error && (
                  <p className={cn("text-xs text-destructive", m.content && "mt-2")}>
                    {m.error}
                  </p>
                )}
              </div>
            </div>
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>

        <form onSubmit={send} className="mt-3 flex gap-2">
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Ask about your finances…"
            disabled={busy}
            autoFocus
          />
          <Button type="submit" disabled={busy || !draft.trim()}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

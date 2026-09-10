"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, ImageIcon, Loader2, MessageSquare, Paperclip, PanelLeft, Plus, Send, Settings2, X } from "lucide-react";
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
  attachments?: { name?: string; kind: string }[];
}

interface Pending {
  name: string;
  media_type: string;
  data: string;
  bytes: number;
  kind: "image" | "pdf";
}

interface ModelOption {
  value: string;
  label: string;
  description?: string;
  effortLevels: string[];
  adaptiveThinking: boolean;
}

interface ChatSettings {
  current: { provider: string; model: string; effort: string | null; thinking: string | null };
  models: ModelOption[];
  capabilities: ModelOption;
}

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const MAX_BYTES = 20 * 1024 * 1024;

/** Strip the `data:...;base64,` prefix — the API wants the payload alone. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });
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
  const [pending, setPending] = useState<Pending[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ChatSettings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  // The thread list is a permanent sidebar on a wide screen and a drawer on a
  // narrow one. Without this it was `lg:` only, which meant a phone could hold
  // a conversation but never reopen one — the history was there and simply
  // unreachable.
  const [showThreads, setShowThreads] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const loadSettings = useCallback(async () => {
    const res = await fetch("/api/chat/settings");
    if (res.ok) setSettings(await res.json());
  }, []);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  async function saveSetting(patch: Record<string, string | null>) {
    await fetch("/api/chat/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await loadSettings();
  }

  /** Shared by the file picker, drag-drop and paste. */
  const addFiles = useCallback(async (files: FileList | File[]) => {
    setAttachError(null);
    const next: Pending[] = [];
    for (const file of Array.from(files)) {
      const isImage = IMAGE_TYPES.includes(file.type);
      const isPdf = file.type === "application/pdf";
      if (!isImage && !isPdf) {
        setAttachError(`${file.name}: images or PDF only`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        setAttachError(`${file.name} is ${(file.size / 1048576).toFixed(1)} MB — the limit is 20 MB`);
        continue;
      }
      next.push({
        name: file.name,
        media_type: file.type,
        data: await readAsBase64(file),
        bytes: file.size,
        kind: isImage ? "image" : "pdf",
      });
    }
    if (next.length) setPending((p) => [...p, ...next]);
  }, []);

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
    setShowThreads(false);
    setConversationId(id);
    setBusy(true);
    const res = await fetch(`/api/chat?conversation_id=${id}`);
    if (res.ok) setMessages((await res.json()).messages ?? []);
    setBusy(false);
  }

  function newThread() {
    setShowThreads(false);
    setConversationId(null);
    setMessages([]);
    setMeta(null);
    setPending([]);
    setAttachError(null);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const message = draft.trim();
    // A file on its own is a fair question — "what is this?" — so only block
    // when there is neither text nor attachment.
    if ((!message && !pending.length) || busy) return;
    const sending = pending;
    setDraft("");
    setPending([]);
    // Shown immediately: the round trip can take seconds on a local model, and
    // an input that empties with nothing appearing looks like a dropped message.
    setMessages((m) => [
      ...m,
      { role: "user", content: message, attachments: sending.map((f) => ({ name: f.name, kind: f.kind })) },
    ]);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          conversation_id: conversationId,
          attachments: sending.map(({ name, media_type, data }) => ({ name, media_type, data })),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessages((m) => [...m, { role: "assistant", content: "", error: data.error }]);
        return;
      }
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
    <div className="relative flex h-[calc(100vh-6rem)] gap-4">
      {/* Backdrop only exists while the drawer is open on a narrow screen. */}
      {showThreads && (
        <button
          type="button"
          aria-label="Close conversations"
          onClick={() => setShowThreads(false)}
          className="absolute inset-0 z-10 bg-background/70 lg:hidden"
        />
      )}

      <aside
        className={cn(
          "w-56 shrink-0 flex-col gap-2 lg:flex",
          showThreads
            ? "absolute inset-y-0 left-0 z-20 flex w-64 rounded-md border bg-background p-2 shadow-lg lg:static lg:w-56 lg:border-0 lg:p-0 lg:shadow-none"
            : "hidden"
        )}
      >
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
        <div className="mb-3 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="lg:hidden"
              onClick={() => setShowThreads((v) => !v)}
              aria-label="Conversations"
            >
              <PanelLeft className="h-4 w-4" />
            </Button>
            <h1 className="truncate text-xl font-semibold">Chat</h1>
          </div>
          <div className="flex items-center gap-2">
            {(meta || settings) && (
              <Badge variant="outline">
                {PROVIDER_LABEL[(meta ?? settings!.current).provider] ??
                  (meta ?? settings!.current).provider}{" "}
                · {(meta ?? settings!.current).model}
                {settings?.current.effort ? ` · ${settings.current.effort}` : ""}
              </Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowSettings((v) => !v)}
              aria-label="Model settings"
            >
              <Settings2 className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {showSettings && settings && (
          <Card className="mb-3">
            <CardContent className="space-y-3 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="space-y-1 text-xs text-muted-foreground">
                  Model
                  <select
                    className="block h-8 rounded-md border bg-background px-2 text-sm"
                    value={settings.current.model}
                    onChange={(e) => saveSetting({ model: e.target.value })}
                  >
                    {settings.models.length === 0 && (
                      <option value={settings.current.model}>{settings.current.model}</option>
                    )}
                    {settings.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-xs text-muted-foreground">
                  Reasoning effort
                  <select
                    className="block h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                    value={settings.current.effort ?? ""}
                    disabled={settings.capabilities.effortLevels.length === 0}
                    onChange={(e) => saveSetting({ effort: e.target.value || null })}
                  >
                    <option value="">provider default</option>
                    {/* Only the levels this model accepts. Offering one it
                        rejects would turn a settings change into a 400. */}
                    {settings.capabilities.effortLevels.map((l) => (
                      <option key={l} value={l}>
                        {l}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="space-y-1 text-xs text-muted-foreground">
                  Thinking
                  <select
                    className="block h-8 rounded-md border bg-background px-2 text-sm disabled:opacity-50"
                    value={settings.current.thinking ?? ""}
                    disabled={!settings.capabilities.adaptiveThinking}
                    onChange={(e) => saveSetting({ thinking: e.target.value || null })}
                  >
                    <option value="">provider default</option>
                    <option value="adaptive">adaptive</option>
                    <option value="off">off</option>
                  </select>
                </label>
              </div>

              <p className="text-xs text-muted-foreground">
                {settings.capabilities.effortLevels.length === 0
                  ? `${settings.current.model} does not accept an effort level — it is left off rather than sent and rejected.`
                  : `Higher effort means more reasoning and more tokens. Chat usually does well at low or medium; the workers are configured separately.`}
              </p>
            </CardContent>
          </Card>
        )}

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
                {m.attachments && m.attachments.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {m.attachments.map((f, j) => (
                      <span
                        key={j}
                        className="inline-flex items-center gap-1 rounded border border-current/20 px-1.5 py-0.5 text-[11px] opacity-80"
                      >
                        {f.kind === "image" ? (
                          <ImageIcon className="h-3 w-3" />
                        ) : (
                          <FileText className="h-3 w-3" />
                        )}
                        {f.name ?? f.kind}
                      </span>
                    ))}
                  </div>
                )}
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

        <form
          onSubmit={send}
          className="mt-3 space-y-2"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
          }}
        >
          {pending.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {pending.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
                >
                  {f.kind === "image" ? (
                    <ImageIcon className="h-3.5 w-3.5" />
                  ) : (
                    <FileText className="h-3.5 w-3.5" />
                  )}
                  <span className="max-w-[180px] truncate">{f.name}</span>
                  <span className="text-muted-foreground">
                    {(f.bytes / 1024).toFixed(0)} KB
                  </span>
                  <button
                    type="button"
                    onClick={() => setPending((p) => p.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${f.name}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachError && <p className="text-xs text-destructive">{attachError}</p>}

          <div className="flex gap-2">
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              disabled={busy}
              onClick={() => fileRef.current?.click()}
              aria-label="Attach a file"
            >
              <Paperclip className="h-4 w-4" />
            </Button>
            <Input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              // Screenshotting a statement and hitting paste is the fastest
              // path to "what is this charge", so it is a first-class one.
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.files ?? []);
                if (files.length) {
                  e.preventDefault();
                  addFiles(files);
                }
              }}
              placeholder="Ask about your finances, or drop in a statement…"
              disabled={busy}
              autoFocus
            />
            <Button type="submit" disabled={busy || (!draft.trim() && !pending.length)}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

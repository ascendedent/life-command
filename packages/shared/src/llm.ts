// One way to ask a model something, whoever the model belongs to.
//
// The platform was wired directly to `new Anthropic()` in four workers, which
// makes an Anthropic API key a hard requirement for running it at all. That is
// fine for the owner and wrong for anyone cloning the repo: the cost of trying
// this should not be a metered API bill.
//
// What is actually possible, per provider, is not symmetric, and pretending
// otherwise would be the useful-sounding kind of lie:
//
//   Anthropic  — a real subscription-shaped login exists. `ant auth login`
//                stores an OAuth profile under ~/.config/anthropic that the
//                SDK reads with no API key present. Nothing here has to
//                implement OAuth; it has to stay out of the way (see the
//                shadowing note on `anthropicClient`).
//   Google     — no login, but AI Studio issues a free-tier key. Not a
//                subscription, and the practical way to run this for nothing.
//   OpenAI     — no path. ChatGPT Plus and Pro do not include API access;
//                they are separately billed products. A key is a key.
//   Ollama     — no account at all. Local models, no network, no bill.
//
// Reusing a browser session cookie from any of these would work and is not
// something this codebase will do.

import { z } from "zod";

export type LlmProvider = "claude_code" | "anthropic" | "google" | "openai" | "ollama";
export type LlmAuth = "api_key" | "oauth" | "none";

export type LlmEffort = "low" | "medium" | "high" | "xhigh" | "max";
/** Normalised across providers; each maps it to whatever it actually calls this. */
export type LlmThinking = "adaptive" | "off";

export interface LlmSettings {
  provider: LlmProvider;
  model: string;
  auth: LlmAuth;
  /** Omitted means the provider default (`high` on Anthropic). */
  effort?: LlmEffort;
  thinking?: LlmThinking;
}

/**
 * What a given model will actually accept — because sending the wrong thing is
 * a 400, not a shrug.
 *
 * The rules are not uniform and not guessable:
 *   - `effort` errors outright on Haiku 4.5.
 *   - `budget_tokens` is *removed* on Sonnet 5, Opus 5, 4.8 and 4.7 — sending
 *     it returns 400 — while Opus 4.6 and Sonnet 4.6 still accept it and Haiku
 *     4.5 *requires* it for any thinking at all.
 *   - Opus 5 thinks by default and only accepts `disabled` at effort `high` or
 *     below; pairing `disabled` with `xhigh`/`max` is a 400.
 *
 * An unknown model gets the conservative row: no effort, no thinking config.
 * A request that omits both is valid on every model, so an unrecognised id
 * degrades to "works" rather than to a stack trace.
 */
export interface ModelCapability {
  /** Null when the parameter is rejected rather than merely ignored. */
  effort: LlmEffort[] | null;
  /** How this model expresses thinking, if at all. */
  thinking: "adaptive" | "budget" | "none";
  /** Whether thinking may be switched off, and under what condition. */
  disableThinking: "yes" | "no" | "effort-high-or-below";
}

const ALL_EFFORT: LlmEffort[] = ["low", "medium", "high", "xhigh", "max"];

/** Named levels mapped onto Gemini's token budget. -1 lets the model decide. */
const GEMINI_BUDGET: Record<LlmEffort, number> = {
  low: 1024, medium: 4096, high: 8192, xhigh: 16384, max: -1,
};
const NO_MAX: LlmEffort[] = ["low", "medium", "high", "xhigh"];

export const MODEL_CAPABILITIES: Record<string, ModelCapability> = {
  "claude-opus-5": { effort: ALL_EFFORT, thinking: "adaptive", disableThinking: "effort-high-or-below" },
  "claude-opus-4-8": { effort: NO_MAX, thinking: "adaptive", disableThinking: "yes" },
  "claude-opus-4-7": { effort: NO_MAX, thinking: "adaptive", disableThinking: "yes" },
  "claude-opus-4-6": { effort: ["low", "medium", "high", "max"], thinking: "adaptive", disableThinking: "yes" },
  "claude-sonnet-5": { effort: NO_MAX, thinking: "adaptive", disableThinking: "yes" },
  "claude-sonnet-4-6": { effort: ["low", "medium", "high", "max"], thinking: "adaptive", disableThinking: "yes" },
  // Effort is not merely ignored here — it errors. Thinking needs a token budget.
  "claude-haiku-4-5": { effort: null, thinking: "budget", disableThinking: "yes" },
};

const CONSERVATIVE: ModelCapability = { effort: null, thinking: "none", disableThinking: "yes" };

export function capabilitiesOf(model: string): ModelCapability {
  return MODEL_CAPABILITIES[model] ?? CONSERVATIVE;
}

/**
 * The effort actually sendable to a model: clamped to what it supports, or
 * undefined when it supports none. Silently dropping an unsupported level
 * beats a 400 the owner cannot act on from a settings page.
 */
export function effortFor(model: string, want: LlmEffort | undefined): LlmEffort | undefined {
  if (!want) return undefined;
  const levels = capabilitiesOf(model).effort;
  if (!levels) return undefined;
  if (levels.includes(want)) return want;
  // Step down to the highest level this model does support.
  for (let i = ALL_EFFORT.indexOf(want); i >= 0; i--) {
    if (levels.includes(ALL_EFFORT[i])) return ALL_EFFORT[i];
  }
  return levels[0];
}

export interface LlmResult<T> {
  parsed: T | null;
  /** The model declined. Distinct from a parse failure. */
  refusal: boolean;
  tokens: number;
  model: string;
  error?: string;
}

export interface LlmRequest<T> {
  settings: LlmSettings;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  /** Name the schema — OpenAI requires one, the others ignore it. */
  schemaName: string;
  maxTokens?: number;
  effort?: "low" | "medium" | "high";
}

export const DEFAULT_MODELS: Record<LlmProvider, string> = {
  // Aliases, not pinned ids: the Agent SDK resolves these against whatever
  // Claude Code ships with, so this keeps working across upgrades.
  claude_code: "sonnet",
  anthropic: "claude-sonnet-5",
  google: "gemini-2.5-flash",
  openai: "gpt-5-mini",
  ollama: "llama3.1",
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * An OAuth profile from `ant auth login`, which the Anthropic SDK picks up on
 * its own — but only if no API key is in the environment. A set
 * `ANTHROPIC_API_KEY` outranks the profile even when it is an empty string, so
 * an owner who logs in and leaves a blank key in `.env` gets a confusing 401
 * rather than the session they just created.
 *
 * Detected by looking for the profile the CLI writes, because asking the SDK
 * would mean making a billable request to find out.
 */
export async function anthropicOauthProfileExists(): Promise<boolean> {
  // Imported inside the function, not at module scope: this file reaches the
  // browser through the shared package root, and `node:fs` does not.
  try {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const dir = `${process.env.XDG_CONFIG_HOME || `${os.homedir()}/.config`}/anthropic`;
    if (!fs.existsSync(dir)) return false;
    return fs.readdirSync(dir).some((f) => f.endsWith(".json"));
  } catch {
    return false;
  }
}

const nonEmpty = (v: string | undefined): boolean => !!v && v.trim().length > 0;

export interface ProviderStatus {
  provider: LlmProvider;
  label: string;
  ready: boolean;
  auth: LlmAuth;
  detail: string;
  /** Whether a subscription-style login (not a key) can drive this provider. */
  subscriptionLogin: "yes" | "no" | "free-tier";
}

/**
 * What each provider could run on right now. Reported rather than guessed at,
 * for the same reason the execution switches are: an empty result and a
 * misconfigured one look identical from the outside.
 */
export async function providerStatuses(): Promise<ProviderStatus[]> {
  const oauth = await anthropicOauthProfileExists();
  const key = nonEmpty(process.env.ANTHROPIC_API_KEY);
  // Claude Code's own credentials, already on this machine. Detected by the
  // presence of its credential file rather than by running anything — asking
  // the SDK would mean making a billable-or-not request to find out.
  let claudeCode = false;
  try {
    const fs = await import("node:fs");
    const os = await import("node:os");
    claudeCode = fs.existsSync(`${os.homedir()}/.claude/.credentials.json`);
  } catch {
    claudeCode = false;
  }

  return [
    {
      provider: "claude_code",
      label: "Claude (signed in)",
      ready: claudeCode,
      auth: claudeCode ? "oauth" : "none",
      subscriptionLogin: "yes",
      detail: claudeCode
        ? "using the Claude Code login already on this machine — no API key, no metered billing. Chat only: no schema-enforced output, so the workers need a second provider."
        : "install Claude Code and sign in — then this needs no API key at all",
    },
    {
      provider: "anthropic",
      label: "Claude (API key)",
      ready: key || oauth,
      auth: key ? "api_key" : oauth ? "oauth" : "none",
      subscriptionLogin: "yes",
      detail: key
        ? oauth
          ? "using ANTHROPIC_API_KEY — it outranks the signed-in profile, so remove the key to use the login"
          : "using ANTHROPIC_API_KEY"
        : oauth
          ? "signed in — no API key needed"
          : "run `ant auth login` to sign in, or set ANTHROPIC_API_KEY",
    },
    {
      provider: "google",
      label: "Gemini",
      ready: nonEmpty(process.env.GOOGLE_AI_API_KEY),
      auth: nonEmpty(process.env.GOOGLE_AI_API_KEY) ? "api_key" : "none",
      subscriptionLogin: "free-tier",
      detail: nonEmpty(process.env.GOOGLE_AI_API_KEY)
        ? "using GOOGLE_AI_API_KEY"
        : "AI Studio issues a free-tier key — no card, no subscription. Set GOOGLE_AI_API_KEY.",
    },
    {
      provider: "openai",
      label: "OpenAI",
      ready: nonEmpty(process.env.OPENAI_API_KEY),
      auth: nonEmpty(process.env.OPENAI_API_KEY) ? "api_key" : "none",
      subscriptionLogin: "no",
      detail: nonEmpty(process.env.OPENAI_API_KEY)
        ? "using OPENAI_API_KEY"
        : "a ChatGPT subscription does not include API access — these are separately billed. Set OPENAI_API_KEY.",
    },
    {
      provider: "ollama",
      label: "Local (Ollama)",
      ready: nonEmpty(process.env.OLLAMA_HOST) || true,
      auth: "none",
      subscriptionLogin: "free-tier",
      detail: `no account and no bill — expects Ollama at ${process.env.OLLAMA_HOST || "http://127.0.0.1:11434"}`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Schema conversion
// ---------------------------------------------------------------------------

/**
 * Every provider but Anthropic wants JSON Schema rather than a Zod object, and
 * each wants a slightly different dialect. OpenAI's strict mode additionally
 * requires that every property be listed in `required` and that objects forbid
 * extra keys — a schema it merely accepts is not a schema it enforces.
 */
export function toJsonSchema(schema: z.ZodType<unknown>, strict: boolean): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  return strict ? harden(json) : json;
}

function harden(node: unknown): Record<string, unknown> {
  if (!node || typeof node !== "object") return node as Record<string, unknown>;
  const n = node as Record<string, unknown>;
  if (n.type === "object" && n.properties && typeof n.properties === "object") {
    n.additionalProperties = false;
    n.required = Object.keys(n.properties as Record<string, unknown>);
    for (const v of Object.values(n.properties as Record<string, unknown>)) harden(v);
  }
  if (n.type === "array" && n.items) harden(n.items);
  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(n[k])) for (const v of n[k] as unknown[]) harden(v);
  }
  return n;
}

// ---------------------------------------------------------------------------
// The call
// ---------------------------------------------------------------------------

/**
 * The Anthropic client, constructed so a signed-in profile is reachable.
 *
 * The SDK resolves credentials in order — ANTHROPIC_API_KEY, then
 * ANTHROPIC_AUTH_TOKEN, then the OAuth profile on disk — and a key set to an
 * empty string still wins. An owner who signs in and leaves `ANTHROPIC_API_KEY=`
 * in their `.env` therefore gets a 401 that blames the login. Under `oauth` the
 * key is removed from this process's environment before the client is built, so
 * the profile is what answers.
 */
async function anthropicClient(auth: LlmAuth) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  if (auth === "oauth") delete process.env.ANTHROPIC_API_KEY;
  return new Anthropic();
}

async function anthropicStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
  const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");
  const client = await anthropicClient(req.settings.auth);
  const res = await client.messages.parse({
    model: req.settings.model,
    max_tokens: req.maxTokens ?? 16000,
    output_config: {
      effort: req.effort ?? "medium",
      format: zodOutputFormat(req.schema as never),
    },
    system: req.system,
    messages: [{ role: "user", content: req.prompt }],
  });
  return {
    parsed: (res.parsed_output as T) ?? null,
    refusal: res.stop_reason === "refusal",
    tokens: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
    model: req.settings.model,
  };
}

/** Shared shape for the three providers that speak JSON Schema over HTTP. */
async function postJson(url: string, body: unknown, headers: Record<string, string>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function googleStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
  const key = process.env.GOOGLE_AI_API_KEY;
  if (!key) throw new Error("GOOGLE_AI_API_KEY is not set");
  const data = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.settings.model)}:generateContent`,
    {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: "user", parts: [{ text: req.prompt }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: toJsonSchema(req.schema, false),
        maxOutputTokens: req.maxTokens ?? 16000,
      },
    },
    { "x-goog-api-key": key }
  );
  const cand = data.candidates?.[0];
  // Gemini reports a refusal as a finish reason, not an error status.
  const refusal = cand?.finishReason === "SAFETY" || cand?.finishReason === "BLOCKLIST";
  const text = cand?.content?.parts?.map((p: { text?: string }) => p.text ?? "").join("") ?? "";
  return {
    parsed: refusal || !text ? null : safeParse<T>(text, req.schema),
    refusal,
    tokens: data.usageMetadata?.totalTokenCount ?? 0,
    model: req.settings.model,
  };
}

async function openaiStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const data = await postJson(
    `${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`,
    {
      model: req.settings.model,
      max_completion_tokens: req.maxTokens ?? 16000,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: req.schemaName,
          strict: true,
          schema: toJsonSchema(req.schema, true),
        },
      },
    },
    { Authorization: `Bearer ${key}` }
  );
  const choice = data.choices?.[0];
  const refusal = !!choice?.message?.refusal;
  return {
    parsed: refusal ? null : safeParse<T>(choice?.message?.content ?? "", req.schema),
    refusal,
    tokens: data.usage?.total_tokens ?? 0,
    model: req.settings.model,
  };
}

async function ollamaStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
  const data = await postJson(
    `${host}/api/chat`,
    {
      model: req.settings.model,
      stream: false,
      format: toJsonSchema(req.schema, false),
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.prompt },
      ],
    },
    {}
  );
  return {
    parsed: safeParse<T>(data.message?.content ?? "", req.schema),
    // A local model has no refusal channel — it either answers or it does not.
    refusal: false,
    tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
    model: req.settings.model,
  };
}

/**
 * Parse and validate. A provider that returns JSON-shaped text has not thereby
 * returned the requested shape, and every caller here treats a null as a failed
 * run rather than a partial one.
 */
function safeParse<T>(text: string, schema: z.ZodType<T>): T | null {
  try {
    const result = schema.safeParse(JSON.parse(text));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/**
 * Ask whichever model the owner configured, and get the same shape back.
 *
 * Every worker that used to construct its own Anthropic client goes through
 * here, so switching provider is a settings change rather than a rewrite — and
 * so the grounding and masking rules the workers apply are applied identically
 * whoever answers.
 */
export async function completeStructured<T>(req: LlmRequest<T>): Promise<LlmResult<T>> {
  try {
    switch (req.settings.provider) {
      case "claude_code":
        // The Agent SDK exposes no schema-enforced output, and every worker
        // that calls this depends on one: the agent's recommendations, the
        // recap's scores, categorisation, receipt parsing. Asking for JSON in a
        // prompt and hoping is not the same guarantee, and the grounding checks
        // downstream assume a shape that was enforced rather than requested.
        //
        // So this provider is chat-only, and says so plainly instead of
        // returning a plausible object that nothing validated. The workers stay
        // on a schema-capable provider even when the chat does not.
        return {
          parsed: null,
          refusal: false,
          tokens: 0,
          model: req.settings.model,
          error:
            "claude_code has no schema-enforced output — it powers the chat, not the workers. Choose anthropic, google, openai or ollama for this.",
        };
      case "anthropic":
        return await anthropicStructured(req);
      case "google":
        return await googleStructured(req);
      case "openai":
        return await openaiStructured(req);
      case "ollama":
        return await ollamaStructured(req);
    }
  } catch (e: unknown) {
    return {
      parsed: null,
      refusal: false,
      tokens: 0,
      model: req.settings.model,
      error: (e as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

/** Which job is asking. Each may pin its own model; all share one provider. */
export type LlmRole = "agent" | "recap" | "enrich" | "receipt" | "chat";

/** Providers whose output can be constrained to a schema. */
const SCHEMA_CAPABLE = new Set<LlmProvider>(["anthropic", "google", "openai", "ollama"]);

const ROLE_ENV: Record<LlmRole, string> = {
  agent: "AGENT_MODEL",
  recap: "RECAP_MODEL",
  enrich: "ENRICH_MODEL",
  receipt: "RECEIPT_MODEL",
  chat: "CHAT_MODEL",
};

/**
 * The provider and model a given job should use.
 *
 * Provider comes from the database so the UI can change it; the model still
 * honours the per-function environment overrides that already existed, because
 * pinning one job to a cheaper model is a normal thing to want and losing that
 * would be a regression dressed as a feature.
 */
export async function resolveLlmSettings(
  db: { from: (t: string) => any },
  role: LlmRole
): Promise<LlmSettings> {
  const { data } = await db
    .from("app_settings")
    .select("llm_provider, llm_auth, llm_chat_provider, llm_chat_auth, llm_chat_model, llm_chat_effort, llm_chat_thinking")
    .eq("id", 1)
    .maybeSingle();

  const shared = (data?.llm_provider ?? process.env.LLM_PROVIDER ?? "anthropic") as LlmProvider;
  let provider =
    role === "chat" ? ((data?.llm_chat_provider as LlmProvider) ?? shared) : shared;
  let auth = (role === "chat"
    ? ((data?.llm_chat_auth as LlmAuth) ?? data?.llm_auth ?? "api_key")
    : (data?.llm_auth ?? "api_key")) as LlmAuth;

  // A chat-only provider handed to a worker produces nothing, every night,
  // quietly. Rather than let a settings change break the agent, fall back and
  // say so — the workers need schema-enforced output and claude_code has none.
  if (role !== "chat" && !SCHEMA_CAPABLE.has(provider)) {
    console.warn(
      `[llm] ${provider} cannot produce schema-enforced output; ${role} falling back to anthropic`
    );
    provider = "anthropic";
    auth = (data?.llm_auth as LlmAuth) === "oauth" ? "api_key" : ((data?.llm_auth as LlmAuth) ?? "api_key");
  }
  const model =
    process.env[ROLE_ENV[role]] ||
    (provider === "anthropic" ? process.env.AGENT_MODEL : undefined) ||
    DEFAULT_MODELS[provider];

  // Chat carries its own model and effort; the workers keep the env-var
  // overrides they already had. Effort is clamped to what the chosen model
  // accepts — see effortFor — so a setting that is valid for one model does not
  // become a 400 when the model changes underneath it.
  if (role === "chat") {
    const chatModel = (data?.llm_chat_model as string) || model;
    return {
      provider,
      model: chatModel,
      auth,
      effort: effortFor(chatModel, (data?.llm_chat_effort as LlmEffort) ?? undefined),
      thinking: (data?.llm_chat_thinking as LlmThinking) ?? undefined,
    };
  }

  return { provider, model, auth };
}

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------

/**
 * A file sent with a turn. `data` is base64 with **no newlines** — the API
 * rejects wrapped base64, and every encoder that writes to a file wraps by
 * default, so this is stripped at the boundary rather than trusted.
 */
export interface LlmAttachment {
  kind: "image" | "pdf";
  media_type: string;
  data: string;
  name?: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  attachments?: LlmAttachment[];
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
export const ATTACHMENT_TYPES = [...IMAGE_TYPES, "application/pdf"];
/** Per file. The whole request is capped at 32 MB, so this leaves headroom. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Anthropic content blocks for one turn.
 *
 * Documents go **before** the text, which is the documented placement and not
 * cosmetic — a PDF after the question is materially worse at being read as the
 * subject of it.
 */
function anthropicBlocks(turn: ChatTurn): unknown[] {
  const blocks: unknown[] = [];
  for (const a of turn.attachments ?? []) {
    blocks.push(
      a.kind === "pdf"
        ? {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: a.data },
          }
        : {
            type: "image",
            source: { type: "base64", media_type: a.media_type, data: a.data },
          }
    );
  }
  blocks.push({ type: "text", text: turn.content });
  return blocks;
}

/** True when any turn carries a file, so text-only paths stay untouched. */
function hasAttachments(turns: ChatTurn[]): boolean {
  return turns.some((t) => t.attachments?.length);
}

export interface ChatResult {
  reply: string | null;
  tokens: number;
  model: string;
  error?: string;
}

/**
 * `claude_code` is the answer to "can this run without an API key".
 *
 * The Claude Agent SDK is Claude Code packaged as a library, and it
 * authenticates the way Claude Code does — against the credentials already on
 * the machine, which for a Pro or Max subscriber is the subscription. No
 * ANTHROPIC_API_KEY, no metered billing, nothing to paste into a settings page.
 *
 * It is also, structurally, Claude Code: a coding agent with a filesystem and a
 * shell. Pointing that at a finance chat without locking it down would give a
 * conversation about spending the ability to read the repo and run commands.
 * So every tool is denied, the Claude Code system preset is replaced with our
 * own, and no filesystem settings are loaded — `settingSources: []` keeps the
 * owner's CLAUDE.md and permission rules out of a context that has no business
 * seeing them. What is left is a plain model call with a subscription behind it.
 */
async function claudeCodeChat(
  system: string,
  turns: ChatTurn[],
  settings: LlmSettings
): Promise<ChatResult> {
  const model = settings.model;
  const { query } = await import("@anthropic-ai/claude-agent-sdk");

  // Two shapes, because the SDK accepts either.
  //
  // Text-only turns render into a single labelled transcript — an unlabelled
  // one reads as one enormous user message and the model loses track of who
  // said what. But a transcript is a string, and a string cannot carry an
  // image, so any turn with a file switches to the streaming form: real
  // MessageParams with real content blocks, which is what the SDK wanted all
  // along and the only way an attachment reaches the model at all.
  const prompt = hasAttachments(turns)
    ? (async function* () {
        for (const t of turns) {
          yield {
            type: "user" as const,
            message: {
              role: "user" as const,
              content: (t.role === "user"
                ? anthropicBlocks(t)
                : [{ type: "text", text: `You previously said: ${t.content}` }]) as never,
            },
            parent_tool_use_id: null,
            session_id: "",
          };
        }
      })()
    : turns.map((t) => `${t.role === "user" ? "Owner" : "You"}: ${t.content}`).join("\n\n");

  let reply = "";
  let tokens = 0;
  try {
    for await (const message of query({
      prompt: prompt as never,
      options: {
        systemPrompt: system,
        model,
        // The SDK takes the same vocabulary as the API. It resolves aliases
        // ("sonnet") itself and silently downgrades an effort level the chosen
        // model does not support, so this can be passed through as written.
        ...(settings.effort ? { effort: settings.effort } : {}),
        ...(settings.thinking === "off"
          ? { thinking: { type: "disabled" as const } }
          : settings.thinking === "adaptive"
            ? { thinking: { type: "adaptive" as const } }
            : {}),
        // Not a coding agent here.
        allowedTools: [],
        disallowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
        permissionMode: "default",
        settingSources: [],
        maxTurns: 1,
      },
    } as never)) {
      const m = message as { type?: string; message?: { content?: unknown; usage?: Record<string, number> } };
      if (m.type !== "assistant") continue;
      const content = m.message?.content;
      if (Array.isArray(content)) {
        for (const block of content as { type?: string; text?: string }[]) {
          if (block.type === "text" && block.text) reply += block.text;
        }
      }
      const u = m.message?.usage;
      if (u) tokens += (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
  } catch (e: unknown) {
    return { reply: null, tokens: 0, model, error: (e as Error).message };
  }
  return { reply: reply.trim() || null, tokens, model };
}

async function anthropicChat(
  system: string,
  turns: ChatTurn[],
  settings: LlmSettings
): Promise<ChatResult> {
  const client = await anthropicClient(settings.auth);
  const caps = capabilitiesOf(settings.model);
  const effort = effortFor(settings.model, settings.effort);

  // Thinking off is only expressible where the model allows it, and on Opus 5
  // only at effort `high` or below — pairing `disabled` with `xhigh`/`max` is a
  // 400. Where it cannot be expressed the request simply omits it, which every
  // model accepts.
  const canDisable =
    caps.disableThinking === "yes" ||
    (caps.disableThinking === "effort-high-or-below" &&
      (!effort || effort === "low" || effort === "medium" || effort === "high"));

  const thinking =
    settings.thinking === "off"
      ? canDisable
        ? { type: "disabled" as const }
        : undefined
      : caps.thinking === "adaptive"
        ? { type: "adaptive" as const }
        : undefined;

  const res = await client.messages.create({
    model: settings.model,
    max_tokens: 4000,
    system,
    // effort lives inside output_config, not at the top level, and is omitted
    // entirely for models that reject it (Haiku 4.5 errors rather than ignores).
    ...(effort ? { output_config: { effort } } : {}),
    ...(thinking ? { thinking } : {}),
    messages: turns.map((t) =>
      t.attachments?.length
        ? { role: t.role, content: anthropicBlocks(t) as never }
        : { role: t.role, content: t.content }
    ),
  });
  const reply = res.content
    .filter((b): b is { type: "text"; text: string; citations: never } => b.type === "text")
    .map((b) => b.text)
    .join("");
  return {
    reply: res.stop_reason === "refusal" ? null : reply.trim() || null,
    tokens: (res.usage?.input_tokens ?? 0) + (res.usage?.output_tokens ?? 0),
    model: settings.model,
    error: res.stop_reason === "refusal" ? "the model declined to answer" : undefined,
  };
}

/**
 * Hold a conversation, on whichever provider the owner configured.
 *
 * Mirrors `completeStructured` deliberately: same settings, same failure shape,
 * so the chat surface and the workers cannot drift apart about who is answering.
 */
export async function chat(
  settings: LlmSettings,
  system: string,
  turns: ChatTurn[]
): Promise<ChatResult> {
  try {
    switch (settings.provider) {
      case "claude_code":
        return await claudeCodeChat(system, turns, settings);
      case "anthropic":
        return await anthropicChat(system, turns, settings);
      case "google": {
        const key = process.env.GOOGLE_AI_API_KEY;
        if (!key) throw new Error("GOOGLE_AI_API_KEY is not set");
        const data = await postJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(settings.model)}:generateContent`,
          {
            systemInstruction: { parts: [{ text: system }] },
            contents: turns.map((t) => ({
              role: t.role === "assistant" ? "model" : "user",
              parts: [
                ...(t.attachments ?? []).map((a) => ({
                  inlineData: { mimeType: a.media_type, data: a.data },
                })),
                { text: t.content },
              ],
            })),
            generationConfig: {
              maxOutputTokens: 4000,
              // Gemini expresses this as a thinking budget, not a named level:
              // -1 lets it decide, 0 turns it off. The named levels are mapped
              // onto that rather than invented.
              ...(settings.thinking === "off"
                ? { thinkingConfig: { thinkingBudget: 0 } }
                : settings.effort
                  ? { thinkingConfig: { thinkingBudget: GEMINI_BUDGET[settings.effort] } }
                  : {}),
            },
          },
          { "x-goog-api-key": key }
        );
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        return {
          reply: parts.map((p: { text?: string }) => p.text ?? "").join("").trim() || null,
          tokens: data.usageMetadata?.totalTokenCount ?? 0,
          model: settings.model,
        };
      }
      case "openai": {
        const key = process.env.OPENAI_API_KEY;
        if (!key) throw new Error("OPENAI_API_KEY is not set");
        const data = await postJson(
          `${process.env.OPENAI_BASE_URL || "https://api.openai.com/v1"}/chat/completions`,
          {
            model: settings.model,
            max_completion_tokens: 4000,
            // OpenAI has three levels, not five; xhigh and max fold into high.
            ...(settings.effort
              ? { reasoning_effort: settings.effort === "low" ? "low" : settings.effort === "medium" ? "medium" : "high" }
              : {}),
            messages: [
              { role: "system", content: system },
              ...turns.map((t) =>
                t.attachments?.length
                  ? {
                      role: t.role,
                      content: [
                        { type: "text", text: t.content },
                        // Chat Completions takes images as data URIs and does
                        // not take PDFs at all; dropping one silently would be
                        // worse than the model not seeing it, so say so inline.
                        ...t.attachments
                          .filter((a) => a.kind === "image")
                          .map((a) => ({
                            type: "image_url",
                            image_url: { url: `data:${a.media_type};base64,${a.data}` },
                          })),
                        ...(t.attachments.some((a) => a.kind === "pdf")
                          ? [{ type: "text", text: "[a PDF was attached; this provider cannot read PDFs on this endpoint]" }]
                          : []),
                      ],
                    }
                  : { role: t.role, content: t.content }
              ),
            ],
          },
          { Authorization: `Bearer ${key}` }
        );
        return {
          reply: data.choices?.[0]?.message?.content?.trim() || null,
          tokens: data.usage?.total_tokens ?? 0,
          model: settings.model,
        };
      }
      case "ollama": {
        const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
        const data = await postJson(
          `${host}/api/chat`,
          {
            model: settings.model,
            stream: false,
            // Ollama has a boolean, not a scale — anything but "off" is on, and
            // only some local models honour it at all.
            ...(settings.thinking ? { think: settings.thinking !== "off" } : {}),
            messages: [
              { role: "system", content: system },
              ...turns.map((t) => ({
                role: t.role,
                content: t.attachments?.some((a) => a.kind === "pdf")
                  ? `${t.content}\n\n[a PDF was attached; local models here cannot read PDFs]`
                  : t.content,
                ...(t.attachments?.some((a) => a.kind === "image")
                  ? { images: t.attachments.filter((a) => a.kind === "image").map((a) => a.data) }
                  : {}),
              })),
            ],
          },
          {}
        );
        return {
          reply: data.message?.content?.trim() || null,
          tokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
          model: settings.model,
        };
      }
    }
  } catch (e: unknown) {
    return { reply: null, tokens: 0, model: settings.model, error: (e as Error).message };
  }
}

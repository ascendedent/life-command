import { NextResponse } from "next/server";
import { requireOwner } from "@/lib/api-auth";
import { MODEL_CAPABILITIES, capabilitiesOf, resolveLlmSettings } from "@finance/shared";

interface ModelOption {
  value: string;
  label: string;
  description?: string;
  effortLevels: string[];
  adaptiveThinking: boolean;
}

/**
 * Which models the chat can actually use, and what each will accept.
 *
 * For `claude_code` this is asked of the SDK rather than hardcoded — it knows
 * what the installed Claude Code ships with, including that Haiku rejects
 * effort, and it stays right across upgrades in a way a table in this repo
 * would not. The query yields nothing and is interrupted immediately, so no
 * turn is spent; it returns in about a second.
 */
async function claudeCodeModels(): Promise<ModelOption[] | null> {
  try {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const q = query({
      prompt: (async function* () {})() as never,
      options: { allowedTools: [], settingSources: [] } as never,
    });
    try {
      const models = await (q as unknown as { supportedModels(): Promise<Record<string, unknown>[]> })
        .supportedModels();
      return models.map((m) => ({
        value: String(m.value),
        label: String(m.displayName ?? m.value),
        description: m.description ? String(m.description) : undefined,
        effortLevels: m.supportsEffort ? ((m.supportedEffortLevels as string[]) ?? []) : [],
        adaptiveThinking: !!m.supportsAdaptiveThinking,
      }));
    } finally {
      try {
        (q as unknown as { interrupt?: () => void }).interrupt?.();
      } catch {
        /* the generator never yielded; nothing to stop */
      }
    }
  } catch {
    // The SDK not answering is not a reason for the settings page to fail —
    // fall through to the static table.
    return null;
  }
}

function staticModels(): ModelOption[] {
  return Object.entries(MODEL_CAPABILITIES).map(([value, cap]) => ({
    value,
    label: value,
    effortLevels: cap.effort ?? [],
    adaptiveThinking: cap.thinking === "adaptive",
  }));
}

export async function GET() {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const current = await resolveLlmSettings(supabase, "chat");
  const models =
    current.provider === "claude_code"
      ? ((await claudeCodeModels()) ?? staticModels())
      : current.provider === "anthropic"
        ? staticModels()
        : [];

  return NextResponse.json({
    current: {
      provider: current.provider,
      model: current.model,
      effort: current.effort ?? null,
      thinking: current.thinking ?? null,
    },
    models,
    // What the currently selected model accepts, so the UI can grey out a level
    // rather than offering one that returns a 400.
    capabilities:
      models.find((m) => m.value === current.model) ??
      (() => {
        const cap = capabilitiesOf(current.model);
        return {
          value: current.model,
          label: current.model,
          effortLevels: cap.effort ?? [],
          adaptiveThinking: cap.thinking === "adaptive",
        };
      })(),
  });
}

export async function PATCH(request: Request) {
  const guard = await requireOwner();
  if ("error" in guard) return guard.error;
  const { supabase } = guard;

  const body = await request.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "bad body" }, { status: 400 });

  const patch: Record<string, unknown> = {};
  if ("model" in body) patch.llm_chat_model = body.model || null;
  if ("effort" in body) patch.llm_chat_effort = body.effort || null;
  if ("thinking" in body) patch.llm_chat_thinking = body.thinking || null;
  if ("provider" in body) patch.llm_chat_provider = body.provider || null;
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  }

  const { error } = await supabase.from("app_settings").update(patch).eq("id", 1);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  await supabase.from("audit_log").insert({
    actor: "user",
    action: "chat_model_changed",
    entity: "app_settings",
    detail: patch,
  });

  // Echoed back resolved rather than as written: effort is clamped per model,
  // so what was saved and what will be sent are not always the same thing.
  return NextResponse.json({ current: await resolveLlmSettings(supabase, "chat") });
}

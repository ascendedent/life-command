// Why execution is off (spec Phase 3a).
//
// Trading is opt-in at five independent points, and the failure mode of that
// design is that four-of-five is indistinguishable from none-of-five: the queue
// is empty either way and nothing says which switch is off. The worker resolves
// the same question for itself every run and writes the answer to a log nobody
// reads.
//
// Pure, so the page and the worker cannot drift into disagreeing about what
// "armed" means, and so it can be tested without a broker or a browser.

export interface ReadinessCheck {
  key: "keys" | "action_type" | "autonomy" | "caps" | "account";
  label: string;
  ok: boolean;
  /** What is true right now, or what to do about it — never both. */
  detail: string;
}

export interface ReadinessInput {
  config: {
    autonomy_level: number;
    max_txn_amount: number;
    max_daily_amount: number;
    max_position_size: number;
    max_open_positions: number;
    allowed_action_types: string[];
  } | null;
  /** Accounts currently flagged agent-controlled. More than one is a refusal. */
  flagged: { name: string; mask: string | null }[];
  brokerConfigured: boolean;
}

export interface Readiness {
  checks: ReadinessCheck[];
  /** All five switches on: the agent may write a trade proposal. */
  canPropose: boolean;
  /** ...and autonomy is at 2, so an approved proposal may actually execute. */
  canExecute: boolean;
}

const CAP_LABELS: Record<string, string> = {
  max_txn_amount: "per-transaction",
  max_daily_amount: "daily",
  max_position_size: "per-position",
  max_open_positions: "open positions",
};

export function executionReadiness(input: ReadinessInput): Readiness {
  const cfg = input.config;
  const level = Number(cfg?.autonomy_level ?? 0);
  const allowed = cfg?.allowed_action_types ?? [];

  const zeroed = (
    ["max_txn_amount", "max_daily_amount", "max_position_size", "max_open_positions"] as const
  ).filter((k) => !Number(cfg?.[k] ?? 0));

  const checks: ReadinessCheck[] = [
    {
      key: "keys",
      label: "Broker keys",
      ok: input.brokerConfigured,
      detail: input.brokerConfigured
        ? "ALPACA_KEY_ID and ALPACA_SECRET_KEY are set"
        : "Set ALPACA_KEY_ID and ALPACA_SECRET_KEY in the root .env, then run npm run env:sync",
    },
    {
      key: "action_type",
      label: "Trade is allow-listed",
      ok: allowed.includes("trade"),
      detail: allowed.length
        ? `allowed: ${allowed.join(", ")}`
        : "nothing is allow-listed, so every action type is refused",
    },
    {
      key: "autonomy",
      label: "Autonomy level",
      ok: level >= 1,
      detail:
        level >= 2
          ? "level 2 — the agent proposes, and an approved trade executes"
          : level === 1
            ? "level 1 — the agent proposes, but nothing executes until level 2"
            : "level 0 is read-only, and disarms proposing as well as executing",
    },
    {
      key: "caps",
      label: "Caps above zero",
      ok: zeroed.length === 0,
      detail: zeroed.length
        ? `still zero: ${zeroed.map((k) => CAP_LABELS[k]).join(", ")} — a cap of zero refuses everything`
        : "every cap is set",
    },
    {
      key: "account",
      label: "One agent-controlled account",
      ok: input.flagged.length === 1,
      detail:
        input.flagged.length === 1
          ? `${input.flagged[0].name} ‥${input.flagged[0].mask ?? "????"}`
          : input.flagged.length
            ? `${input.flagged.length} accounts are flagged — the agent must never pick between them, so trading stays off`
            : "no account is flagged, so there is nowhere for an order to land",
    },
  ];

  const all = checks.every((c) => c.ok);
  return { checks, canPropose: all, canExecute: all && level >= 2 };
}

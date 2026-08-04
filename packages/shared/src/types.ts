// Hand-written types for Phase 0. Replace/augment with generated types via
// `npm run db:types` (supabase gen types) once the stack is running.

export type WorkerName = "sync" | "agent" | "executor";

export interface WorkerHeartbeat {
  worker_name: WorkerName;
  status: "ok" | "idle" | "stub" | "stopped" | "error";
  last_beat_at: string;
  started_at: string | null;
  details: Record<string, unknown> | null;
}

export type RecommendationStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed"
  | "failed"
  | "expired";

export type AutonomyLevel = 0 | 1 | 2 | 3;

export interface AgentConfig {
  id: number;
  autonomy_level: AutonomyLevel;
  max_txn_amount: number;
  max_daily_amount: number;
  max_open_positions: number;
  max_position_size: number;
  drawdown_halt_pct: number;
  allowed_action_types: string[];
  updated_at: string;
}

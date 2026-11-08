export interface Budget {
  maxSteps: number;
  maxMs: number;
}

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_SECONDS = 600;

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function budgetFromEnv(
  env: Record<string, string | undefined> = process.env,
): Budget {
  const maxSteps = Number(env.AGENT_MAX_STEPS ?? String(DEFAULT_MAX_STEPS));
  const maxSeconds = Number(env.AGENT_MAX_SECONDS ?? String(DEFAULT_MAX_SECONDS));
  return {
    maxSteps: positiveInt(maxSteps, DEFAULT_MAX_STEPS),
    maxMs: positiveInt(maxSeconds * 1000, DEFAULT_MAX_SECONDS * 1000),
  };
}

export function budgetReason(
  budget: Budget,
  stepsUsed: number,
  elapsedMs: number,
): string | null {
  if (stepsUsed >= budget.maxSteps) return `step budget exhausted (${budget.maxSteps})`;
  if (elapsedMs >= budget.maxMs) {
    return `time budget exhausted (${Math.round(budget.maxMs / 1000)}s)`;
  }
  return null;
}

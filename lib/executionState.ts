/**
 * Execution state machine for trade lifecycle tracking.
 * Tracks each trade through its stages and records timing for KPI analysis.
 */

export type ExecutionPhase =
  | 'idle'
  | 'precheck'
  | 'arm'
  | 'submit_both'
  | 'one_leg_filled'
  | 'hedge_or_abort'
  | 'pending_funding'
  | 'wait_settlement_confirm'
  | 'confirmed_close'
  | 'flatten'
  | 'reconcile'
  | 'cooldown';

export interface ExecutionStateEntry {
  tradeId: string;
  asset: string;
  shortExchange: string;
  longExchange: string;
  phase: ExecutionPhase;
  phaseHistory: Array<{ phase: ExecutionPhase; enteredAt: number; exitedAt?: number }>;
  startedAt: number;
  completedAt?: number;
  outcome?: 'success' | 'aborted' | 'forced_close' | 'error';
  orphanLegMs?: number;
  fundingCaptured?: boolean;
  settlementConfirmed?: boolean;
  evDecision?: number;
  evRealized?: number;
}

const activeStates = new Map<string, ExecutionStateEntry>();
const completedStates: ExecutionStateEntry[] = [];
const MAX_COMPLETED_HISTORY = 500;

export function createExecutionState(
  tradeId: string,
  asset: string,
  shortExchange: string,
  longExchange: string,
): ExecutionStateEntry {
  const entry: ExecutionStateEntry = {
    tradeId,
    asset,
    shortExchange,
    longExchange,
    phase: 'idle',
    phaseHistory: [{ phase: 'idle', enteredAt: Date.now() }],
    startedAt: Date.now(),
  };
  activeStates.set(tradeId, entry);
  return entry;
}

export function transitionPhase(tradeId: string, nextPhase: ExecutionPhase): ExecutionStateEntry | null {
  const entry = activeStates.get(tradeId);
  if (!entry) return null;

  const now = Date.now();
  // Close current phase
  const current = entry.phaseHistory[entry.phaseHistory.length - 1];
  if (current) current.exitedAt = now;

  // Enter new phase
  entry.phase = nextPhase;
  entry.phaseHistory.push({ phase: nextPhase, enteredAt: now });

  return entry;
}

export function completeExecution(
  tradeId: string,
  outcome: ExecutionStateEntry['outcome'],
  metrics?: {
    orphanLegMs?: number;
    fundingCaptured?: boolean;
    settlementConfirmed?: boolean;
    evDecision?: number;
    evRealized?: number;
  },
): ExecutionStateEntry | null {
  const entry = activeStates.get(tradeId);
  if (!entry) return null;

  const now = Date.now();
  const current = entry.phaseHistory[entry.phaseHistory.length - 1];
  if (current) current.exitedAt = now;

  entry.completedAt = now;
  entry.outcome = outcome;
  if (metrics) {
    entry.orphanLegMs = metrics.orphanLegMs;
    entry.fundingCaptured = metrics.fundingCaptured;
    entry.settlementConfirmed = metrics.settlementConfirmed;
    entry.evDecision = metrics.evDecision;
    entry.evRealized = metrics.evRealized;
  }

  activeStates.delete(tradeId);
  completedStates.push(entry);
  if (completedStates.length > MAX_COMPLETED_HISTORY) {
    completedStates.splice(0, completedStates.length - MAX_COMPLETED_HISTORY);
  }

  return entry;
}

export function getActiveStates(): ExecutionStateEntry[] {
  return Array.from(activeStates.values());
}

export function getCompletedStates(): ExecutionStateEntry[] {
  return [...completedStates];
}

export function getExecutionState(tradeId: string): ExecutionStateEntry | undefined {
  return activeStates.get(tradeId);
}

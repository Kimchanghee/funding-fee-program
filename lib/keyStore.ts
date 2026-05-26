import type { StrategyConfig, LogEntry, FundingPayment, SimPosition } from './types';
import { sanitizeFeeOverrides, sanitizePaybackOverrides, getResolvedTimingConfig } from './types';

// Enabled exchanges persistence
const ENABLED_EXCHANGES_KEY = 'funding_fee_enabled_exchanges';

export function saveEnabledExchanges(exchanges: string[]): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ENABLED_EXCHANGES_KEY, JSON.stringify(exchanges));
}

export function loadEnabledExchanges(): string[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(ENABLED_EXCHANGES_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Storage schema version — bumped whenever default shape changes so stale
// localStorage from prior builds gets cleared instead of overriding updated
// strategy defaults.
const SCHEMA_VERSION_KEY = 'funding_fee_schema_version';
// Bumped to v6 so clients carrying the aggressive profile are re-seeded with
// the best-record 2026-04-17~20 strategy defaults.
const CURRENT_SCHEMA_VERSION = 'v6-best-record-defaults-2026-05-07';

export function runLocalStorageMigrations(): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = localStorage.getItem(SCHEMA_VERSION_KEY);
    if (stored === CURRENT_SCHEMA_VERSION) return;
    // Clear money-related state so updated defaults surface on next boot.
    localStorage.removeItem('funding_fee_strategy_config');
    localStorage.removeItem('funding_fee_sim_state');
    localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION);
  } catch {
    // localStorage unavailable — ignore; in-memory defaults still apply.
  }
}

// Strategy config persistence
const STRATEGY_CONFIG_KEY = 'funding_fee_strategy_config';

export function saveStrategyConfig(config: StrategyConfig): void {
  if (typeof window === 'undefined') return;
  const normalized: StrategyConfig = {
    ...config,
    feeOverrides: sanitizeFeeOverrides(config.feeOverrides),
    paybackOverrides: sanitizePaybackOverrides(config.paybackOverrides),
    timingConfig: getResolvedTimingConfig(config.timingConfig),
  };
  localStorage.setItem(STRATEGY_CONFIG_KEY, JSON.stringify(normalized));
}

export function loadStrategyConfig(): StrategyConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STRATEGY_CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StrategyConfig;
    return {
      ...parsed,
      feeOverrides: sanitizeFeeOverrides(parsed.feeOverrides),
      paybackOverrides: sanitizePaybackOverrides(parsed.paybackOverrides),
      timingConfig: getResolvedTimingConfig(parsed.timingConfig),
    };
  } catch {
    return null;
  }
}

// Logs persistence
const LOGS_KEY = 'funding_fee_logs';

export function saveLogs(logs: LogEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs));
  } catch { /* quota exceeded - silent */ }
}

export function loadLogs(): LogEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LOGS_KEY);
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// Funding history persistence
const FUNDING_HISTORY_KEY = 'funding_fee_history';

export function saveFundingHistory(history: FundingPayment[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(FUNDING_HISTORY_KEY, JSON.stringify(history));
  } catch { /* quota exceeded - silent */ }
}

export function loadFundingHistory(): FundingPayment[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(FUNDING_HISTORY_KEY);
    if (raw === null) return null; // key missing -> server/file fallback can repopulate
    return JSON.parse(raw);        // [] means intentionally cleared
  } catch {
    return null;
  }
}

// Sim state persistence (balances, positions, totalEarned)
const SIM_STATE_KEY = 'funding_fee_sim_state';
const SIM_HISTORY_RESET_AT_KEY = 'funding_fee_sim_history_reset_at';

interface SimState {
  simBalances: Record<string, number>;
  simInitialBalances?: Record<string, number>;
  simPositions: SimPosition[];
  simTotalFundingEarned: number;
  simTotalTopUps?: number;
  simTotalFees?: number;
  simTotalClosedPnl?: number;
  simClosedPnlPerExchange?: Partial<Record<string, number>>;
  simClosedFeesPerExchange?: Partial<Record<string, number>>;
}

export function saveSimState(state: SimState): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SIM_STATE_KEY, JSON.stringify(state));
  } catch { /* quota exceeded - silent */ }
}

export function loadSimState(): SimState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SIM_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearSimState(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(SIM_STATE_KEY);
}

export function saveSimHistoryResetAt(timestamp: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(SIM_HISTORY_RESET_AT_KEY, JSON.stringify(timestamp));
  } catch {}
}

export function loadSimHistoryResetAt(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(SIM_HISTORY_RESET_AT_KEY);
    if (!raw) return 0;
    const value = Number(JSON.parse(raw));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

// Simulation mode persistence
const SIM_MODE_KEY = 'funding_fee_sim_mode';

export function saveSimMode(mode: boolean): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(SIM_MODE_KEY, JSON.stringify(mode)); } catch {}
}

export function clearFundingHistory(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(FUNDING_HISTORY_KEY);
}

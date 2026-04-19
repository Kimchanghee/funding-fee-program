import type { ApiConfig, ExchangeId, StrategyConfig, LogEntry, FundingPayment, SimPosition } from './types';
import { sanitizeFeeOverrides, sanitizePaybackOverrides, getResolvedTimingConfig } from './types';

const STORAGE_KEY = 'funding_fee_api_configs_v2';
const LEGACY_STORAGE_KEY = 'funding_fee_api_configs';

// Simple obfuscation to prevent casual plaintext reading of API keys in localStorage.
// NOTE: This is NOT encryption - client-side storage is inherently vulnerable to XSS.
// For production use, consider server-side key storage with session-based access.
const OBF_PREFIX = 'obf:';

function obfuscate(value: string): string {
  try {
    return OBF_PREFIX + btoa(encodeURIComponent(value));
  } catch {
    return value;
  }
}

function deobfuscate(value: string): string {
  if (!value.startsWith(OBF_PREFIX)) return value; // legacy plaintext
  try {
    return decodeURIComponent(atob(value.slice(OBF_PREFIX.length)));
  } catch {
    return value;
  }
}

function obfuscateConfig(config: ApiConfig): ApiConfig {
  return {
    apiKey: obfuscate(config.apiKey),
    secret: obfuscate(config.secret),
    ...(config.passphrase ? { passphrase: obfuscate(config.passphrase) } : {}),
  };
}

function deobfuscateConfig(config: ApiConfig): ApiConfig {
  return {
    apiKey: deobfuscate(config.apiKey),
    secret: deobfuscate(config.secret),
    ...(config.passphrase ? { passphrase: deobfuscate(config.passphrase) } : {}),
  };
}

export function saveApiConfigs(configs: Partial<Record<ExchangeId, ApiConfig>>): void {
  if (typeof window === 'undefined') return;
  const encoded: Partial<Record<ExchangeId, ApiConfig>> = {};
  for (const [ex, cfg] of Object.entries(configs) as [ExchangeId, ApiConfig][]) {
    encoded[ex] = obfuscateConfig(cfg);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(encoded));
  // Clean up legacy plaintext key
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

export function loadApiConfigs(): Partial<Record<ExchangeId, ApiConfig>> {
  if (typeof window === 'undefined') return {};
  try {
    // Try new format first, then migrate legacy
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return {};
      // Migrate: re-save with obfuscation
      const legacy = JSON.parse(raw) as Partial<Record<ExchangeId, ApiConfig>>;
      saveApiConfigs(legacy); // saves as obfuscated + removes legacy key
      return legacy;
    }
    const parsed = JSON.parse(raw) as Partial<Record<ExchangeId, ApiConfig>>;
    const decoded: Partial<Record<ExchangeId, ApiConfig>> = {};
    for (const [ex, cfg] of Object.entries(parsed) as [ExchangeId, ApiConfig][]) {
      decoded[ex] = deobfuscateConfig(cfg);
    }
    return decoded;
  } catch {
    return {};
  }
}

export function clearApiConfigs(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LEGACY_STORAGE_KEY);
}

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
// localStorage from prior builds gets cleared instead of overriding the new
// zero-defaults. Only the money-related keys are cleared; API keys and the
// other user-managed blobs survive the migration.
const SCHEMA_VERSION_KEY = 'funding_fee_schema_version';
const CURRENT_SCHEMA_VERSION = 'v2-zero-2026-04-19';

export function runLocalStorageMigrations(): void {
  if (typeof window === 'undefined') return;
  try {
    const stored = localStorage.getItem(SCHEMA_VERSION_KEY);
    if (stored === CURRENT_SCHEMA_VERSION) return;
    // Clear legacy money-related state so the new $0 defaults surface.
    localStorage.removeItem('funding_fee_strategy_config');
    localStorage.removeItem('funding_fee_sim_state');
    localStorage.setItem(SCHEMA_VERSION_KEY, CURRENT_SCHEMA_VERSION);
  } catch {
    // localStorage unavailable — ignore; the in-memory zero defaults will apply.
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
const REAL_HISTORY_RESET_AT_KEY = 'funding_fee_real_history_reset_at';

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

export function saveRealHistoryResetAt(timestamp: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(REAL_HISTORY_RESET_AT_KEY, JSON.stringify(timestamp));
  } catch {}
}

export function loadRealHistoryResetAt(): number {
  if (typeof window === 'undefined') return 0;
  try {
    const raw = localStorage.getItem(REAL_HISTORY_RESET_AT_KEY);
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

export function loadSimMode(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(SIM_MODE_KEY);
    if (raw === null) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// Real position meta persistence
const REAL_META_KEY = 'funding_fee_real_position_meta';

export function saveRealPositionMeta(meta: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(REAL_META_KEY, JSON.stringify(meta)); } catch {}
}

export function loadRealPositionMeta(): Record<string, unknown> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(REAL_META_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

export function clearFundingHistory(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(FUNDING_HISTORY_KEY);
}

import type { ApiConfig, ExchangeId, StrategyConfig, LogEntry, FundingPayment, SimPosition } from './types';

const STORAGE_KEY = 'funding_fee_api_configs_v2';
const LEGACY_STORAGE_KEY = 'funding_fee_api_configs';

// Simple obfuscation to prevent casual plaintext reading of API keys in localStorage.
// NOTE: This is NOT encryption — client-side storage is inherently vulnerable to XSS.
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

// ── Enabled Exchanges persistence ──────────────
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

// ── Strategy Config persistence ──────────────
const STRATEGY_CONFIG_KEY = 'funding_fee_strategy_config';

export function saveStrategyConfig(config: StrategyConfig): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STRATEGY_CONFIG_KEY, JSON.stringify(config));
}

export function loadStrategyConfig(): StrategyConfig | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STRATEGY_CONFIG_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ── Logs persistence ──────────────
const LOGS_KEY = 'funding_fee_logs';
const MAX_PERSISTED_LOGS = 200;

export function saveLogs(logs: LogEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(LOGS_KEY, JSON.stringify(logs.slice(0, MAX_PERSISTED_LOGS)));
  } catch { /* quota exceeded — silent */ }
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

// ── Funding History persistence ──────────────
const FUNDING_HISTORY_KEY = 'funding_fee_history';
const MAX_PERSISTED_HISTORY = 500;

export function saveFundingHistory(history: FundingPayment[]): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(FUNDING_HISTORY_KEY, JSON.stringify(history.slice(0, MAX_PERSISTED_HISTORY)));
  } catch { /* quota exceeded — silent */ }
}

export function loadFundingHistory(): FundingPayment[] | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = localStorage.getItem(FUNDING_HISTORY_KEY);
    if (raw === null) return null; // 키 자체가 없음 → 서버에서 복원 가능
    return JSON.parse(raw);        // 빈 배열이면 [] → 명시적으로 비운 것
  } catch {
    return null;
  }
}

// ── Sim State persistence (balances, positions, totalEarned) ──────────────
const SIM_STATE_KEY = 'funding_fee_sim_state';

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
  } catch { /* quota exceeded — silent */ }
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

export function clearFundingHistory(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(FUNDING_HISTORY_KEY);
}

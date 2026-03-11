import type { ApiConfig, ExchangeId } from './types';

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

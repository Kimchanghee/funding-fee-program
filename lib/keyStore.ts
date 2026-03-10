import type { ApiConfig, ExchangeId } from './types';

const STORAGE_KEY = 'funding_fee_api_configs';

export function saveApiConfigs(configs: Partial<Record<ExchangeId, ApiConfig>>): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(configs));
}

export function loadApiConfigs(): Partial<Record<ExchangeId, ApiConfig>> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function clearApiConfigs(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}

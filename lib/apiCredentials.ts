import type { ApiConfig, ExchangeId } from './types';

const EXCHANGES_REQUIRING_PASSPHRASE: ReadonlySet<ExchangeId> = new Set(['okx', 'bitget']);

function hasNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function requiresPassphrase(exchange: ExchangeId): boolean {
  return EXCHANGES_REQUIRING_PASSPHRASE.has(exchange);
}

export function hasRequiredApiCredentials(
  exchange: ExchangeId,
  config?: Partial<ApiConfig> | null,
): boolean {
  if (!config) return false;
  if (!hasNonEmpty(config.apiKey) || !hasNonEmpty(config.secret)) return false;
  if (requiresPassphrase(exchange) && !hasNonEmpty(config.passphrase)) return false;
  return true;
}

export function getMissingApiCredentialFields(
  exchange: ExchangeId,
  config?: Partial<ApiConfig> | null,
): Array<'apiKey' | 'secret' | 'passphrase'> {
  const missing: Array<'apiKey' | 'secret' | 'passphrase'> = [];
  if (!hasNonEmpty(config?.apiKey)) missing.push('apiKey');
  if (!hasNonEmpty(config?.secret)) missing.push('secret');
  if (requiresPassphrase(exchange) && !hasNonEmpty(config?.passphrase)) missing.push('passphrase');
  return missing;
}

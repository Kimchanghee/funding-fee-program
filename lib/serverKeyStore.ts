import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { ApiConfig, ExchangeId } from './types';
import { getDataDir } from './dataDir';

const DATA_DIR = getDataDir();
const KEY_FILE = join(DATA_DIR, 'api-keys.enc.json');
const MASTER_KEY_FILE = join(DATA_DIR, '.master-key');

function ensureDataDir() {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function getMasterKey(): Buffer {
  ensureDataDir();
  // Use env variable if set, otherwise auto-generate and persist
  const envKey = process.env.API_KEY_MASTER_SECRET;
  if (envKey) return scryptSync(envKey, 'funding-fee-salt', 32);

  if (existsSync(MASTER_KEY_FILE)) {
    return Buffer.from(readFileSync(MASTER_KEY_FILE, 'utf-8'), 'hex');
  }
  const key = randomBytes(32);
  writeFileSync(MASTER_KEY_FILE, key.toString('hex'), { mode: 0o600 });
  return key;
}

function encrypt(text: string): string {
  const key = getMasterKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), encrypted.toString('hex'), tag.toString('hex')].join(':');
}

function decrypt(data: string): string {
  const key = getMasterKey();
  const [ivHex, encHex, tagHex] = data.split(':');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return decipher.update(Buffer.from(encHex, 'hex'), undefined, 'utf8') + decipher.final('utf8');
}

export function saveServerApiConfig(exchange: ExchangeId, config: ApiConfig): void {
  const all = loadAllServerApiConfigs();
  all[exchange] = config;
  ensureDataDir();
  const plaintext = JSON.stringify(all);
  writeFileSync(KEY_FILE, encrypt(plaintext), 'utf-8');
}

export function removeServerApiConfig(exchange: ExchangeId): void {
  const all = loadAllServerApiConfigs();
  delete all[exchange];
  ensureDataDir();
  writeFileSync(KEY_FILE, encrypt(JSON.stringify(all)), 'utf-8');
}

export function loadAllServerApiConfigs(): Partial<Record<ExchangeId, ApiConfig>> {
  if (!existsSync(KEY_FILE)) return {};
  try {
    const raw = readFileSync(KEY_FILE, 'utf-8');
    return JSON.parse(decrypt(raw));
  } catch {
    return {};
  }
}

export function loadServerApiConfig(exchange: ExchangeId): ApiConfig | undefined {
  return loadAllServerApiConfigs()[exchange];
}

export function listConfiguredExchanges(): ExchangeId[] {
  return Object.keys(loadAllServerApiConfigs()) as ExchangeId[];
}

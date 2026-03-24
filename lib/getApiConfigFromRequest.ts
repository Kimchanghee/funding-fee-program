import { NextRequest } from 'next/server';
import type { ApiConfig, ExchangeId } from './types';
import { loadServerApiConfig } from './serverKeyStore';

/** 서버 측 암호화 키 우선, fallback으로 요청 헤더 키 사용 */
export function getApiConfigFromRequest(req: NextRequest, exchange: ExchangeId): ApiConfig {
  const serverConfig = loadServerApiConfig(exchange);
  if (serverConfig?.apiKey && serverConfig?.secret) {
    return serverConfig;
  }
  // Fallback: 클라이언트 헤더 (하위 호환)
  return {
    apiKey: req.headers.get('x-api-key') || '',
    secret: req.headers.get('x-api-secret') || '',
    passphrase: req.headers.get('x-api-passphrase') || undefined,
  };
}

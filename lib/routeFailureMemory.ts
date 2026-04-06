import type { TradeEvent } from './fileLogger';

const DEFAULT_WINDOW_MS = 90 * 60 * 1000;
const MIN_BLOCK_MS = 60 * 1000;
const MAX_BLOCK_MS = 45 * 60 * 1000;

interface RouteFailureState {
  timestamps: number[];
  score: number;
  blockedUntil: number;
  lastReason: string;
}

function normalizeReason(reason?: string): string {
  return (reason ?? 'unknown').toLowerCase();
}

function getReasonPolicy(reasonRaw?: string): { cooldownMs: number; weight: number } {
  const reason = normalizeReason(reasonRaw);
  if (reason.includes('revalidate_spread_reverted')) return { cooldownMs: 6 * 60 * 1000, weight: 1.5 };
  if (reason.includes('profitability')) return { cooldownMs: 2 * 60 * 1000, weight: 0.7 };
  if (reason.includes('depth')) return { cooldownMs: 12 * 60 * 1000, weight: 1.8 };
  if (reason.includes('slippage') || reason.includes('impact') || reason.includes('entry_gap')) {
    return { cooldownMs: 10 * 60 * 1000, weight: 1.7 };
  }
  if (reason.includes('orderbook')) return { cooldownMs: 4 * 60 * 1000, weight: 1.0 };
  if (reason.includes('balance') || reason.includes('margin')) return { cooldownMs: 2 * 60 * 1000, weight: 0.8 };
  if (reason.includes('position already active')) return { cooldownMs: 60 * 1000, weight: 0.3 };
  return { cooldownMs: 3 * 60 * 1000, weight: 0.9 };
}

function getRouteKeyFromEvent(event: TradeEvent): string | null {
  if (!event.baseAsset || !event.shortExchange || !event.longExchange) return null;
  return makeRouteFailureKey(event.baseAsset, event.shortExchange, event.longExchange);
}

export function makeRouteFailureKey(baseAsset: string, shortExchange: string, longExchange: string): string {
  return `${baseAsset.toUpperCase()}:${shortExchange}:${longExchange}`;
}

export class RouteFailureMemory {
  private states = new Map<string, RouteFailureState>();

  constructor(private readonly windowMs = DEFAULT_WINDOW_MS) {}

  clear() {
    this.states.clear();
  }

  ingestEvents(
    events: TradeEvent[],
    options?: { simulation?: boolean; now?: number },
  ) {
    if (events.length === 0) return;
    const now = options?.now ?? Date.now();
    const cutoff = now - this.windowMs;

    const chronological = events
      .filter((event) => {
        if (event.timestamp < cutoff) return false;
        if (typeof options?.simulation === 'boolean' && event.simulation !== options.simulation) return false;
        return true;
      })
      .sort((a, b) => a.timestamp - b.timestamp);

    for (const event of chronological) {
      const routeKey = getRouteKeyFromEvent(event);
      if (!routeKey) continue;

      if (event.type === 'guard_block') {
        this.recordFailure(routeKey, event.reason, event.timestamp);
        continue;
      }

      if (event.type === 'entry' || event.type === 'snipe_entry') {
        if (event.success === false) {
          this.recordFailure(routeKey, event.reason ?? 'entry_failed', event.timestamp);
        } else {
          this.recordSuccess(routeKey, event.timestamp);
        }
      }
    }

    this.prune(now);
  }

  recordFailure(routeKey: string, reason?: string, timestamp = Date.now()) {
    const state = this.states.get(routeKey) ?? {
      timestamps: [],
      score: 0,
      blockedUntil: 0,
      lastReason: 'unknown',
    };
    const { cooldownMs, weight } = getReasonPolicy(reason);
    const cutoff = timestamp - this.windowMs;
    const recent = state.timestamps.filter((ts) => ts >= cutoff);
    recent.push(timestamp);

    const failCount = recent.length;
    const multiplier = failCount >= 8 ? 3 : failCount >= 5 ? 2.5 : failCount >= 3 ? 2 : 1;
    const blockMs = Math.min(MAX_BLOCK_MS, Math.max(MIN_BLOCK_MS, Math.round(cooldownMs * multiplier)));

    state.timestamps = recent;
    state.score = Math.min(10, state.score * 0.85 + weight + Math.max(0, failCount - 1) * 0.15);
    state.blockedUntil = Math.max(state.blockedUntil, timestamp + blockMs);
    state.lastReason = normalizeReason(reason);
    this.states.set(routeKey, state);
  }

  recordSuccess(routeKey: string, timestamp = Date.now()) {
    const state = this.states.get(routeKey);
    if (!state) return;

    const cutoff = timestamp - this.windowMs;
    state.timestamps = state.timestamps.filter((ts) => ts >= cutoff);
    state.score = Math.max(0, state.score * 0.35 - 0.5);
    state.blockedUntil = Math.min(state.blockedUntil, timestamp);
    this.states.set(routeKey, state);
    this.prune(timestamp);
  }

  isBlocked(routeKey: string, now = Date.now()): boolean {
    const state = this.states.get(routeKey);
    if (!state) return false;
    if (state.blockedUntil <= now) return false;
    return state.score >= 0.5;
  }

  private prune(now: number) {
    const cutoff = now - this.windowMs;
    for (const [routeKey, state] of this.states.entries()) {
      state.timestamps = state.timestamps.filter((ts) => ts >= cutoff);
      const stale = state.timestamps.length === 0 && state.blockedUntil <= now;
      if (stale || state.score <= 0.01) {
        this.states.delete(routeKey);
      } else {
        this.states.set(routeKey, state);
      }
    }
  }
}

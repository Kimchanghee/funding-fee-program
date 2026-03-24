/**
 * Server-side auto-scheduler — 브라우저 없이도 서버에서 독립적으로
 * 펀딩률 폴링, 기회 탐색, 스나이프 진입/청산을 수행합니다.
 *
 * PM2가 프로세스를 유지하므로 브라우저를 닫아도 계속 동작합니다.
 * 서버 재시작 시 data/scheduler-state.json에서 자동 재개합니다.
 */

import { fetchFundingRates, openPositionExact, closePosition, fetchMarketFillPrice } from './exchanges';
import { findOpportunities } from './opportunities';
import { loadAllServerApiConfigs } from './serverKeyStore';
import { getHedgeFees, type ExchangeId, type ArbitrageOpportunity, type FundingRate } from './types';
import { sendTelegramMessage } from './telegram';
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const DATA_DIR = join(process.cwd(), 'data');
const STATE_FILE = join(DATA_DIR, 'scheduler-state.json');
const LOG_FILE = join(DATA_DIR, 'scheduler.log');

export interface SchedulerConfig {
  investmentUSDT: number;
  leverage: number;
  minSpreadPercent: number;
  enabledExchanges: ExchangeId[];
  maxConcurrentPairs: number;
}

interface PersistedState {
  active: boolean;
  config: SchedulerConfig;
  startedAt: number | null;
  stats: SchedulerStats;
}

interface SchedulerStats {
  totalEntries: number;
  totalCloses: number;
  totalProfit: number;
  errors: number;
}

interface ScheduledEntry {
  asset: string;
  opportunity: ArbitrageOpportunity;
  timer: ReturnType<typeof setTimeout>;
  targetTime: number;
}

interface ActivePosition {
  asset: string;
  shortExchange: ExchangeId;
  longExchange: ExchangeId;
  shortSymbol: string;
  longSymbol: string;
  shortAmount: number;
  longAmount: number;
  closeTimer: ReturnType<typeof setTimeout>;
  entryTime: number;
  pairId: string;
}

class ServerScheduler {
  private static instance: ServerScheduler | null = null;

  private active = false;
  private config: SchedulerConfig = {
    investmentUSDT: 500,
    leverage: 5,
    minSpreadPercent: 0.01,
    enabledExchanges: [],
    maxConcurrentPairs: 5,
  };
  private startedAt: number | null = null;
  private stats: SchedulerStats = { totalEntries: 0, totalCloses: 0, totalProfit: 0, errors: 0 };

  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private scheduledEntries = new Map<string, ScheduledEntry>();
  private activePositions = new Map<string, ActivePosition>();
  private lastPollTime = 0;
  private _resumeChecked = false;

  static getInstance(): ServerScheduler {
    if (!ServerScheduler.instance) {
      ServerScheduler.instance = new ServerScheduler();
    }
    return ServerScheduler.instance;
  }

  private constructor() {
    this._tryAutoResume();
  }

  // ── 서버 재시작 시 자동 재개 ──

  private _tryAutoResume() {
    if (this._resumeChecked) return;
    this._resumeChecked = true;

    try {
      if (!existsSync(STATE_FILE)) return;
      const saved: PersistedState = JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
      if (saved.active && saved.config.enabledExchanges.length > 0) {
        this.log('info', `서버 재시작 감지 — 자동 재개 (이전 시작: ${new Date(saved.startedAt!).toISOString()})`);
        this.config = saved.config;
        this.stats = saved.stats;
        this.startedAt = saved.startedAt;
        this.active = true;
        this._startPolling();
      }
    } catch (err) {
      this.log('error', `자동 재개 실패: ${(err as Error).message}`);
    }
  }

  // ── Public API ──

  start(config: SchedulerConfig) {
    if (this.active) this.stop();

    this.active = true;
    this.config = config;
    this.startedAt = Date.now();
    this.stats = { totalEntries: 0, totalCloses: 0, totalProfit: 0, errors: 0 };

    this._saveState();
    this._startPolling();
    this.log('info',
      `서버 스케줄러 시작 — 투자금: $${config.investmentUSDT} 레버리지: ${config.leverage}x ` +
      `거래소: ${config.enabledExchanges.join(',')} 최소스프레드: ${config.minSpreadPercent}%`,
    );
    void sendTelegramMessage(
      `🟢 [서버 스케줄러] 시작\n투자금: $${config.investmentUSDT} | 레버리지: ${config.leverage}x\n` +
      `거래소: ${config.enabledExchanges.join(', ')}\n최소스프레드: ${config.minSpreadPercent}%`,
    );
  }

  stop() {
    // 폴링 중지
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // 예약 진입 타이머 정리
    for (const [, entry] of this.scheduledEntries) {
      clearTimeout(entry.timer);
    }
    this.scheduledEntries.clear();

    // 청산 타이머 정리 (활성 포지션은 유지 — 수동 청산 필요)
    for (const [, pos] of this.activePositions) {
      clearTimeout(pos.closeTimer);
    }

    const hadActive = this.activePositions.size;
    this.active = false;
    this._saveState();
    this.log('info',
      `서버 스케줄러 정지 — 총 진입: ${this.stats.totalEntries} 총 청산: ${this.stats.totalCloses}` +
      (hadActive > 0 ? ` ⚠️ 활성 포지션 ${hadActive}개 — 수동 청산 필요` : ''),
    );
    void sendTelegramMessage(
      `🔴 [서버 스케줄러] 정지\n총 진입: ${this.stats.totalEntries} | 총 청산: ${this.stats.totalCloses}` +
      (hadActive > 0 ? `\n⚠️ 활성 포지션 ${hadActive}개 — 수동 청산 필요` : ''),
    );
  }

  getStatus() {
    return {
      active: this.active,
      config: this.config,
      startedAt: this.startedAt,
      stats: this.stats,
      scheduledEntries: Array.from(this.scheduledEntries.values()).map(v => ({
        asset: v.asset,
        targetTime: v.targetTime,
        shortExchange: v.opportunity.shortExchange,
        longExchange: v.opportunity.longExchange,
        spreadPercent: v.opportunity.spreadPercent,
      })),
      activePositions: Array.from(this.activePositions.values()).map(v => ({
        asset: v.asset,
        shortExchange: v.shortExchange,
        longExchange: v.longExchange,
        entryTime: v.entryTime,
      })),
      lastPollTime: this.lastPollTime,
    };
  }

  isActive() {
    return this.active;
  }

  // ── 내부: 폴링 루프 ──

  private _startPolling() {
    if (this.pollInterval) clearInterval(this.pollInterval);
    // 첫 폴 2초 후
    setTimeout(() => this._poll(), 2_000);
    // 30초 간격 반복
    this.pollInterval = setInterval(() => this._poll(), 30_000);
  }

  private async _poll() {
    if (!this.active) return;
    const now = Date.now();
    this.lastPollTime = now;

    try {
      // 모든 활성 거래소에서 펀딩률 조회
      const results = await Promise.allSettled(
        this.config.enabledExchanges.map(ex => fetchFundingRates(ex)),
      );

      const rates = results
        .filter((r): r is PromiseFulfilledResult<FundingRate[]> => r.status === 'fulfilled')
        .flatMap(r => r.value);

      if (rates.length === 0) return;

      // 기회 탐색
      const opportunities = findOpportunities(
        rates, 50, this.config.investmentUSDT, this.config.leverage,
      );

      // 이미 예약/활성인 자산 제외
      const busyAssets = new Set([
        ...this.scheduledEntries.keys(),
        ...this.activePositions.keys(),
      ]);

      const filtered = opportunities.filter(o => {
        if (busyAssets.has(o.baseAsset)) return false;
        if (!this.config.enabledExchanges.includes(o.shortExchange)) return false;
        if (!this.config.enabledExchanges.includes(o.longExchange)) return false;
        const aheadMs = Math.max(5 * 3600000, o.fundingIntervalMs ?? 8 * 3600000);
        if (o.nextFundingTime - now > aheadMs) return false;
        if (o.nextFundingTime < now) return false;
        if (o.spreadPercent < this.config.minSpreadPercent) return false;
        if (o.netProfit <= 0) return false;
        return true;
      });

      // 빈 슬롯 수 계산
      const currentCount = this.scheduledEntries.size + this.activePositions.size;
      const slotsAvailable = this.config.maxConcurrentPairs - currentCount;
      const toSchedule = filtered.slice(0, Math.max(0, slotsAvailable));

      for (const opp of toSchedule) {
        this._scheduleEntry(opp);
      }
    } catch (err) {
      this.log('error', `폴링 에러: ${(err as Error).message}`);
      this.stats.errors++;
    }
  }

  // ── 내부: 진입 스케줄링 ──

  private _scheduleEntry(opportunity: ArbitrageOpportunity) {
    const asset = opportunity.baseAsset;
    if (this.scheduledEntries.has(asset)) return;

    const ENTRY_BEFORE_MS = 5_000;
    const intervalMs = opportunity.fundingIntervalMs ?? 8 * 3600000;
    let targetTime = opportunity.nextFundingTime;
    const now = Date.now();

    while (targetTime <= now) targetTime += intervalMs;
    if (targetTime - now < 6_000) targetTime += intervalMs;

    const entryDelay = Math.max(0, targetTime - now - ENTRY_BEFORE_MS);
    const timer = setTimeout(() => this._executeEntry(opportunity, targetTime), entryDelay);

    this.scheduledEntries.set(asset, { asset, opportunity, timer, targetTime });

    const mins = Math.floor(entryDelay / 60000);
    const secs = Math.floor((entryDelay / 1000) % 60);
    this.log('info',
      `[스케줄] ${asset} 예약 — ${mins}분 ${secs}초 후 | ` +
      `${opportunity.shortExchange}↔${opportunity.longExchange} +${opportunity.spreadPercent.toFixed(4)}%`,
    );
  }

  // ── 내부: 진입 실행 ──

  private async _executeEntry(opportunity: ArbitrageOpportunity, targetFundingTime: number) {
    const asset = opportunity.baseAsset;
    this.scheduledEntries.delete(asset);

    if (!this.active) {
      this.log('warning', `[진입] ${asset} 스킵 — 스케줄러 비활성`);
      return;
    }

    // 시간 검증
    const secsUntilFunding = (targetFundingTime - Date.now()) / 1000;
    if (secsUntilFunding < -10) {
      this.log('warning', `[진입] ${asset} 차단 — 펀딩 ${Math.abs(secsUntilFunding).toFixed(0)}초 전에 지남`);
      return;
    }
    if (secsUntilFunding > 30) {
      this.log('warning', `[진입] ${asset} 차단 — 펀딩까지 ${secsUntilFunding.toFixed(0)}초 (너무 이름)`);
      return;
    }

    const apiConfigs = loadAllServerApiConfigs();
    const shortConfig = apiConfigs[opportunity.shortExchange];
    const longConfig = apiConfigs[opportunity.longExchange];

    if (!shortConfig || !longConfig) {
      this.log('error', `[진입] ${asset} API 키 없음 — ${opportunity.shortExchange}/${opportunity.longExchange}`);
      this.stats.errors++;
      return;
    }

    try {
      const targetNotional = this.config.investmentUSDT * this.config.leverage;

      // 오더북 조회
      const [shortFill, longFill] = await Promise.all([
        fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', targetNotional),
        fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', targetNotional),
      ]);

      // 수익성 게이트
      const entryGapPct = ((longFill.fillPrice - shortFill.fillPrice) / shortFill.fillPrice) * 100;
      const hedgeFeePct = getHedgeFees(opportunity.shortExchange, opportunity.longExchange, 'taker') * 100;
      const SAFETY_MARGIN = 0.03;
      const realNetSpread = opportunity.spreadPercent - entryGapPct * 1.5 - hedgeFeePct - SAFETY_MARGIN;

      if (realNetSpread <= 0) {
        this.log('warning',
          `[진입] ${asset} 수익성 미달: 순스프레드 ${realNetSpread.toFixed(4)}% ` +
          `(진입갭 ${entryGapPct.toFixed(4)}%, 수수료 ${hedgeFeePct.toFixed(3)}%)`,
        );
        return;
      }

      // 수량 계산
      const shortQty = targetNotional / shortFill.fillPrice;
      const longQty = targetNotional / longFill.fillPrice;
      const PRICE_BUFFER = 0.0005;
      const shortLimitPrice = shortFill.worstPrice * (1 - PRICE_BUFFER);
      const longLimitPrice = longFill.worstPrice * (1 + PRICE_BUFFER);

      this.log('info',
        `[진입] ${asset} 실행 — 펀딩까지 ${secsUntilFunding.toFixed(1)}초 | ` +
        `순스프레드 ${realNetSpread.toFixed(4)}%`,
      );

      // 양쪽 동시 실행
      const [shortResult, longResult] = await Promise.allSettled([
        openPositionExact(
          opportunity.shortExchange, shortConfig, opportunity.shortSymbol,
          'short', shortQty, shortLimitPrice, this.config.leverage,
        ),
        openPositionExact(
          opportunity.longExchange, longConfig, opportunity.longSymbol,
          'long', longQty, longLimitPrice, this.config.leverage,
        ),
      ]);

      const shortOk = shortResult.status === 'fulfilled';
      const longOk = longResult.status === 'fulfilled';

      // 편측 실패 → 롤백
      if (shortOk && !longOk) {
        const errMsg = (longResult as PromiseRejectedResult).reason?.message || 'unknown';
        try {
          await closePosition(opportunity.shortExchange, shortConfig, opportunity.shortSymbol, 'short', shortResult.value.amount);
          this.log('warning', `[진입] ${asset} 롱 실패(${errMsg}) → 숏 롤백 완료`);
        } catch (rbErr) {
          this.log('error', `[진입] ${asset} 롱 실패 + 숏 롤백 실패 — 수동 확인: ${(rbErr as Error).message}`);
        }
        this.stats.errors++;
        return;
      }
      if (!shortOk && longOk) {
        const errMsg = (shortResult as PromiseRejectedResult).reason?.message || 'unknown';
        try {
          await closePosition(opportunity.longExchange, longConfig, opportunity.longSymbol, 'long', longResult.value.amount);
          this.log('warning', `[진입] ${asset} 숏 실패(${errMsg}) → 롱 롤백 완료`);
        } catch (rbErr) {
          this.log('error', `[진입] ${asset} 숏 실패 + 롱 롤백 실패 — 수동 확인: ${(rbErr as Error).message}`);
        }
        this.stats.errors++;
        return;
      }
      if (!shortOk && !longOk) {
        this.log('error',
          `[진입] ${asset} 양쪽 실패 — 숏:${(shortResult as PromiseRejectedResult).reason?.message} ` +
          `롱:${(longResult as PromiseRejectedResult).reason?.message}`,
        );
        this.stats.errors++;
        return;
      }

      // 양쪽 성공 (위에서 shortOk && longOk 확인됨)
      if (shortResult.status !== 'fulfilled' || longResult.status !== 'fulfilled') return;
      const shortData = shortResult.value;
      const longData = longResult.value;
      const pairId = `srv-${Date.now()}-${asset}`;

      this.stats.totalEntries++;
      this.log('success',
        `[진입] ${asset} 완료 — 숏 $${shortData.filledNotional.toFixed(2)} 롱 $${longData.filledNotional.toFixed(2)}`,
      );

      void sendTelegramMessage(
        `📈 [서버] ${asset} 진입 완료\n` +
        `숏: ${opportunity.shortExchange.toUpperCase()} $${shortData.filledNotional.toFixed(2)}\n` +
        `롱: ${opportunity.longExchange.toUpperCase()} $${longData.filledNotional.toFixed(2)}\n` +
        `스프레드: +${opportunity.spreadPercent.toFixed(4)}%`,
      );

      // 청산 예약: 펀딩 시간 + 2초
      const closeDelay = Math.max(0, targetFundingTime - Date.now()) + 2_000;
      const closeTimer = setTimeout(() => this._executeClose(asset), closeDelay);

      this.activePositions.set(asset, {
        asset,
        shortExchange: opportunity.shortExchange,
        longExchange: opportunity.longExchange,
        shortSymbol: opportunity.shortSymbol,
        longSymbol: opportunity.longSymbol,
        shortAmount: shortData.amount,
        longAmount: longData.amount,
        closeTimer,
        entryTime: Date.now(),
        pairId,
      });

      this._saveState();
    } catch (err) {
      this.log('error', `[진입] ${asset} 에러: ${(err as Error).message}`);
      this.stats.errors++;
    }
  }

  // ── 내부: 청산 실행 ──

  private async _executeClose(asset: string) {
    const pos = this.activePositions.get(asset);
    if (!pos) return;

    const apiConfigs = loadAllServerApiConfigs();
    const shortConfig = apiConfigs[pos.shortExchange];
    const longConfig = apiConfigs[pos.longExchange];

    if (!shortConfig || !longConfig) {
      this.log('error', `[청산] ${asset} API 키 없음 — 수동 청산 필요`);
      this.stats.errors++;
      return;
    }

    this.log('info', `[청산] ${asset} 실행 중...`);

    try {
      const [shortClose, longClose] = await Promise.allSettled([
        closePosition(pos.shortExchange, shortConfig, pos.shortSymbol, 'short', pos.shortAmount),
        closePosition(pos.longExchange, longConfig, pos.longSymbol, 'long', pos.longAmount),
      ]);

      const shortOk = shortClose.status === 'fulfilled';
      const longOk = longClose.status === 'fulfilled';

      if (shortOk && longOk) {
        this.stats.totalCloses++;
        this.log('success', `[청산] ${asset} 완료`);
        void sendTelegramMessage(`✅ [서버] ${asset} 청산 완료`);
      } else {
        const failed: string[] = [];
        if (!shortOk) failed.push(`숏:${(shortClose as PromiseRejectedResult).reason?.message}`);
        if (!longOk) failed.push(`롱:${(longClose as PromiseRejectedResult).reason?.message}`);
        this.log('error', `[청산] ${asset} 부분 실패 — ${failed.join(' | ')}`);
        this.stats.errors++;

        // 3초 후 실패한 쪽 재시도
        setTimeout(async () => {
          try {
            if (!shortOk) {
              await closePosition(pos.shortExchange, shortConfig!, pos.shortSymbol, 'short', pos.shortAmount);
              this.log('success', `[청산-재시도] ${asset} 숏 성공`);
            }
            if (!longOk) {
              await closePosition(pos.longExchange, longConfig!, pos.longSymbol, 'long', pos.longAmount);
              this.log('success', `[청산-재시도] ${asset} 롱 성공`);
            }
            this.stats.totalCloses++;
            void sendTelegramMessage(`✅ [서버] ${asset} 청산 재시도 성공`);
          } catch (retryErr) {
            this.log('error', `[청산-재시도] ${asset} 실패 — 수동 확인 필요: ${(retryErr as Error).message}`);
            void sendTelegramMessage(`❌ [서버] ${asset} 청산 재시도 실패 — 수동 확인 필요`);
          }
        }, 3_000);
      }
    } catch (err) {
      this.log('error', `[청산] ${asset} 에러: ${(err as Error).message}`);
      this.stats.errors++;
    }

    this.activePositions.delete(asset);
    this._saveState();
  }

  // ── 상태 저장/로깅 ──

  private _saveState() {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      const state: PersistedState = {
        active: this.active,
        config: this.config,
        startedAt: this.startedAt,
        stats: this.stats,
      };
      writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } catch { /* ignore */ }
  }

  private log(level: string, message: string) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    console.log(`[ServerScheduler] ${line}`);
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      appendFileSync(LOG_FILE, line + '\n');
    } catch { /* ignore */ }
  }
}

export function getServerScheduler(): ServerScheduler {
  return ServerScheduler.getInstance();
}

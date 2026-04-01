import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, ApiConfig, ArbitrageOpportunity, FeeOverrides, ConfirmedSnipeConfig } from '@/lib/types';
import {
  SUPPORTED_EXCHANGES,
  hasValidFeeOverrides,
  sanitizeFeeOverrides,
  DEFAULT_CONFIRMED_SNIPE_CONFIG,
  MAX_ROUND_TRIP_IMPACT_BPS,
  MIN_FREE_MARGIN_PCT,
  HEDGE_RATIO_MIN,
  HEDGE_RATIO_MAX,
} from '@/lib/types';
import { pairUsesInstantaneousRate } from '@/lib/exchangeProfiles';
import { calcConservativeEV, calcDriftBuffer } from '@/lib/opportunities';
import { checkPairLiquidationDistance } from '@/lib/liquidationGuard';
import {
  openPositionExact,
  fetchBalance,
  fetchFundingRates,
  fetchMarketFillPrice,
  closePosition,
  getPartialExecution,
  type ExecutedOrderSummary,
} from '@/lib/exchanges';
import { rebalanceExecutedHedge } from '@/lib/hedgeRebalance';
import { resolveRuntimeFee, resolveRuntimeFeeDetailed, refreshFeeCache } from '@/lib/runtimeFeeCache';
import { loadAllServerApiConfigs } from '@/lib/serverKeyStore';
import { makeServerPositionKey, upsertServerPositionMeta } from '@/lib/serverPositionMeta';
import { hasRequiredApiCredentials } from '@/lib/apiCredentials';

function isValidApiConfig(exchange: ExchangeId, config: unknown): config is ApiConfig {
  if (!config || typeof config !== 'object') return false;
  return hasRequiredApiCredentials(exchange, config as Partial<ApiConfig>);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown';
}

async function rollbackExecutedLegs(legs: Array<{
  label: string;
  exchange: ExchangeId;
  config: ApiConfig;
  symbol: string;
  side: 'long' | 'short';
  execution: ExecutedOrderSummary;
  failureReason: string;
}>): Promise<string | undefined> {
  if (legs.length === 0) return undefined;

  const results = await Promise.allSettled(legs.map(async (leg) => {
    await closePosition(
      leg.exchange,
      leg.config,
      leg.symbol,
      leg.side,
      leg.execution.amount,
      undefined,
    );
    return `${leg.label} rollback ok (${leg.failureReason})`;
  }));

  return results.map((result, index) => {
    const leg = legs[index];
    return result.status === 'fulfilled'
      ? result.value
      : `${leg.label} rollback failed (${leg.failureReason}): ${getErrorMessage(result.reason)}`;
  }).join(' | ');
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      opportunity: ArbitrageOpportunity;
      investmentUSDT: number;
      leverage: number;
      apiConfigs?: Partial<Record<ExchangeId, ApiConfig>>;
      pairId?: string;
      feeOverrides?: FeeOverrides;
      maxSlippagePercent?: number;
      confirmedSnipeConfig?: ConfirmedSnipeConfig;
    };

    const { opportunity, investmentUSDT, leverage, apiConfigs, feeOverrides, maxSlippagePercent } = body;
    const snipeConfig = body.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
    const normalizedFeeOverrides = sanitizeFeeOverrides(feeOverrides);
    let shortRateForDecision = opportunity?.shortRate ?? 0;
    let longRateForDecision = opportunity?.longRate ?? 0;
    const pairId = typeof body.pairId === 'string' && body.pairId.trim()
      ? body.pairId.trim()
      : `api-${Date.now()}-${opportunity?.baseAsset ?? 'pair'}`;

    // Runtime validation
    if (!opportunity?.shortExchange || !opportunity?.longExchange || !opportunity?.shortSymbol || !opportunity?.longSymbol) {
      return NextResponse.json({ success: false, error: 'Invalid opportunity data' }, { status: 400 });
    }
    if (!SUPPORTED_EXCHANGES.includes(opportunity.shortExchange) || !SUPPORTED_EXCHANGES.includes(opportunity.longExchange)) {
      return NextResponse.json({ success: false, error: 'Unsupported exchange in opportunity' }, { status: 400 });
    }
    if (typeof investmentUSDT !== 'number' || investmentUSDT <= 0) {
      return NextResponse.json({ success: false, error: 'Invalid investmentUSDT' }, { status: 400 });
    }
    if (typeof leverage !== 'number' || leverage < 1 || leverage > 125) {
      return NextResponse.json({ success: false, error: 'Invalid leverage' }, { status: 400 });
    }
    if (!hasValidFeeOverrides(feeOverrides)) {
      return NextResponse.json({ success: false, error: 'Invalid feeOverrides' }, { status: 400 });
    }
    if (
      maxSlippagePercent !== undefined
      && (
        typeof maxSlippagePercent !== 'number'
        || !Number.isFinite(maxSlippagePercent)
        || maxSlippagePercent <= 0
        || maxSlippagePercent > 10
      )
    ) {
      return NextResponse.json({ success: false, error: 'Invalid maxSlippagePercent (0, 10]' }, { status: 400 });
    }

    // 서버 측 암호화 키 저장소 우선, fallback으로 클라이언트 전송 키 사용
    const serverConfigs = loadAllServerApiConfigs();
    const shortConfig = serverConfigs[opportunity.shortExchange] ?? apiConfigs?.[opportunity.shortExchange];
    const longConfig = serverConfigs[opportunity.longExchange] ?? apiConfigs?.[opportunity.longExchange];

    if (
      !isValidApiConfig(opportunity.shortExchange, shortConfig)
      || !isValidApiConfig(opportunity.longExchange, longConfig)
    ) {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid API credentials for one or both exchanges' },
        { status: 400 },
      );
    }

    // ── Refresh runtime fee cache for both exchanges ──
    await Promise.allSettled([
      refreshFeeCache(opportunity.shortExchange, shortConfig, opportunity.shortSymbol),
      refreshFeeCache(opportunity.longExchange, longConfig, opportunity.longSymbol),
    ]);
    const shortFeeInfo = resolveRuntimeFeeDetailed(opportunity.shortExchange, 'taker', normalizedFeeOverrides);
    const longFeeInfo = resolveRuntimeFeeDetailed(opportunity.longExchange, 'taker', normalizedFeeOverrides);
    if (shortFeeInfo.source === 'preset' || longFeeInfo.source === 'preset') {
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} BLOCKED — fee cache unavailable: ` +
        `${opportunity.shortExchange}=${shortFeeInfo.source} ${opportunity.longExchange}=${longFeeInfo.source}`,
      );
      return NextResponse.json({
        success: false,
        error: `실계정 fee cache 확보 실패: ${opportunity.shortExchange}=${shortFeeInfo.source} ${opportunity.longExchange}=${longFeeInfo.source}`,
        reason: 'fee_cache_unavailable',
      }, { status: 503 });
    }

    // ── 100% Hedge: 양쪽 오더북 동시 조회 → 동일 notional 수량 계산 → 동시 실행 ──
    const targetNotional = investmentUSDT * leverage;
    const shortEntryFeeEstimate = targetNotional * resolveRuntimeFee(
      opportunity.shortExchange,
      'taker',
      normalizedFeeOverrides,
    );
    const longEntryFeeEstimate = targetNotional * resolveRuntimeFee(
      opportunity.longExchange,
      'taker',
      normalizedFeeOverrides,
    );
    const requiredShortBalance = investmentUSDT + shortEntryFeeEstimate;
    const requiredLongBalance = investmentUSDT + longEntryFeeEstimate;

    const [shortBalance, longBalance] = await Promise.all([
      fetchBalance(opportunity.shortExchange, shortConfig),
      fetchBalance(opportunity.longExchange, longConfig),
    ]);

    if (shortBalance.availableUSDT < requiredShortBalance || longBalance.availableUSDT < requiredLongBalance) {
      return NextResponse.json({
        success: false,
        error: `잔고 부족: ${opportunity.shortExchange} ${shortBalance.availableUSDT.toFixed(2)} / 필요 ${requiredShortBalance.toFixed(2)}, ${opportunity.longExchange} ${longBalance.availableUSDT.toFixed(2)} / 필요 ${requiredLongBalance.toFixed(2)}`,
        reason: 'insufficient_balance',
        required: {
          [opportunity.shortExchange]: requiredShortBalance,
          [opportunity.longExchange]: requiredLongBalance,
        },
        available: {
          [opportunity.shortExchange]: shortBalance.availableUSDT,
          [opportunity.longExchange]: longBalance.availableUSDT,
        },
      });
    }

    // Free margin guard
    const shortFreeRatio = shortBalance.totalUSDT > 0
      ? (shortBalance.availableUSDT / shortBalance.totalUSDT) * 100 : 0;
    const longFreeRatio = longBalance.totalUSDT > 0
      ? (longBalance.availableUSDT / longBalance.totalUSDT) * 100 : 0;
    if (shortFreeRatio < MIN_FREE_MARGIN_PCT || longFreeRatio < MIN_FREE_MARGIN_PCT) {
      return NextResponse.json({
        success: false,
        error: `Free margin 부족: ${opportunity.shortExchange}=${shortFreeRatio.toFixed(1)}% ${opportunity.longExchange}=${longFreeRatio.toFixed(1)}% (min ${MIN_FREE_MARGIN_PCT}%)`,
        reason: 'free_margin_low',
      });
    }

    // Liquidation distance guard
    try {
      const liqCheck = await checkPairLiquidationDistance(
        opportunity.shortExchange, opportunity.longExchange,
        shortConfig, longConfig,
        opportunity.shortSymbol, opportunity.longSymbol,
      );
      if (!liqCheck.safe) {
        return NextResponse.json({
          success: false,
          error: `청산가 거리 부족: ${liqCheck.detail}`,
          reason: 'liq_distance_low',
        });
      }
    } catch (liqErr) {
      return NextResponse.json({
        success: false,
        error: `청산가 거리 체크 실패: ${getErrorMessage(liqErr)}`,
        reason: 'liq_check_failed',
      }, { status: 503 });
    }

    // Revalidate live funding right before execution to avoid stale-route entries.
    try {
      const [shortRates, longRates] = await Promise.all([
        fetchFundingRates(opportunity.shortExchange, undefined, [opportunity.shortSymbol]),
        fetchFundingRates(opportunity.longExchange, undefined, [opportunity.longSymbol]),
      ]);
      const shortLiveRate = shortRates.find((rate) => rate.symbol === opportunity.shortSymbol)
        ?? shortRates.find((rate) => rate.baseAsset === opportunity.baseAsset);
      const longLiveRate = longRates.find((rate) => rate.symbol === opportunity.longSymbol)
        ?? longRates.find((rate) => rate.baseAsset === opportunity.baseAsset);

      if (!shortLiveRate || !longLiveRate) {
        return NextResponse.json({
          success: false,
          error: `Live funding revalidate failed: short=${shortRates.length}, long=${longRates.length}`,
          reason: 'funding_revalidate_missing',
        }, { status: 503 });
      }

      const liveSpread = shortLiveRate.rate - longLiveRate.rate;
      if (liveSpread <= 0) {
        return NextResponse.json({
          success: false,
          error: `Live spread reverted: ${(liveSpread * 100).toFixed(4)}%`,
          reason: 'live_spread_reverted',
        });
      }

      shortRateForDecision = shortLiveRate.rate;
      longRateForDecision = longLiveRate.rate;
    } catch (revalidateErr) {
      return NextResponse.json({
        success: false,
        error: `Live funding revalidate error: ${getErrorMessage(revalidateErr)}`,
        reason: 'funding_revalidate_failed',
      }, { status: 503 });
    }

    // 1. Pre-fetch orderbooks from both exchanges simultaneously
    const [shortFill, longFill] = await Promise.all([
      fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', targetNotional),
      fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', targetNotional),
    ]);

    // 2a. Impact / Slippage guard
    if (snipeConfig.useImpactGuards) {
      // v2.1: impact-based guard — per-exchange mid, round-trip bps cap
      const roundTripImpactBps = (shortFill.slippagePercent + longFill.slippagePercent) * 2 * 100;
      if (roundTripImpactBps > (snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS)) {
        const cap = snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS;
        console.log(
          `[EXECUTE] ${opportunity.baseAsset} BLOCKED — round-trip impact: ` +
          `${roundTripImpactBps.toFixed(1)}bps > ${cap}bps`,
        );
        return NextResponse.json({
          success: false,
          error: `Round-trip impact ${roundTripImpactBps.toFixed(1)}bps > ${cap}bps cap`,
          reason: 'impact_exceeded',
          roundTripImpactBps,
          maxRoundTripImpactBps: cap,
        });
      }
    } else {
      // Legacy: slippage % guard
      const MAX_SLIPPAGE_PCT = maxSlippagePercent ?? 1.5;
      if (shortFill.slippagePercent > MAX_SLIPPAGE_PCT || longFill.slippagePercent > MAX_SLIPPAGE_PCT) {
        const worstSide = shortFill.slippagePercent > longFill.slippagePercent ? 'short' : 'long';
        const worstExchange = worstSide === 'short' ? opportunity.shortExchange : opportunity.longExchange;
        const worstSlippage = Math.max(shortFill.slippagePercent, longFill.slippagePercent);
        console.log(
          `[EXECUTE] ${opportunity.baseAsset} BLOCKED — 슬리피지 초과: ` +
          `${worstSide}(${worstExchange})=${worstSlippage.toFixed(4)}% > ${MAX_SLIPPAGE_PCT}% | ` +
          `short(${opportunity.shortExchange})=${shortFill.slippagePercent.toFixed(4)}% long(${opportunity.longExchange})=${longFill.slippagePercent.toFixed(4)}%`,
        );
        return NextResponse.json({
          success: false,
          error: `슬리피지 초과: ${worstSide}(${worstExchange}) ${worstSlippage.toFixed(4)}% > ${MAX_SLIPPAGE_PCT}%`,
          reason: 'slippage_exceeded',
          shortSlippage: shortFill.slippagePercent,
          longSlippage: longFill.slippagePercent,
          maxSlippage: MAX_SLIPPAGE_PCT,
        });
      }
    }

    // 2b. Cross-exchange entry gap guard
    const entryGapPct = ((longFill.fillPrice - shortFill.fillPrice) / shortFill.fillPrice) * 100;
    // When impact guards are ON, entry gap is already covered by round-trip impact cap.
    // When OFF, use legacy slippage threshold.
    const entryGapThreshold = snipeConfig.useImpactGuards
      ? (snipeConfig.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 100  // convert bps to %
      : (maxSlippagePercent ?? 1.5);
    if (Math.abs(entryGapPct) > entryGapThreshold) {
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} BLOCKED — 거래소 간 가격 괴리 초과: ` +
        `entryGap=${entryGapPct.toFixed(4)}% > ${entryGapThreshold.toFixed(4)}% | ` +
        `short(${opportunity.shortExchange})=${shortFill.fillPrice} long(${opportunity.longExchange})=${longFill.fillPrice}`,
      );
      return NextResponse.json({
        success: false,
        error: `거래소 간 가격 괴리 초과: ${entryGapPct.toFixed(4)}% > ${entryGapThreshold.toFixed(4)}%`,
        reason: 'entry_gap_exceeded',
        entryGapPct,
        maxGap: entryGapThreshold,
      });
    }

    // 2c. Pre-execution profitability gate — conservative EV (always forced ON)
    const execHedgeFeePct = (
      resolveRuntimeFee(opportunity.shortExchange, 'taker', normalizedFeeOverrides)
      + resolveRuntimeFee(opportunity.longExchange, 'taker', normalizedFeeOverrides)
    ) * 2 * 100;

    {
      const usesInstantRate = pairUsesInstantaneousRate(
        opportunity.shortExchange, opportunity.longExchange,
      );
      const shortDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(shortRateForDecision, undefined, usesInstantRate)
        : 0;
      const longDrift = snipeConfig.useDriftBuffer
        ? calcDriftBuffer(longRateForDecision, undefined, usesInstantRate)
        : 0;
      const roundTripFeeDec = execHedgeFeePct / 100;
      const entryImpactDec = (shortFill.slippagePercent + longFill.slippagePercent) / 100;
      const ev = calcConservativeEV(
        targetNotional,
        shortRateForDecision, longRateForDecision,
        shortDrift, longDrift,
        roundTripFeeDec, entryImpactDec, entryImpactDec,
      );

      if (!ev.passesMinProfit || !ev.passesEVRatio) {
        console.log(
          `[EXECUTE] ${opportunity.baseAsset} BLOCKED — conservative EV: ` +
          `$${ev.expectedNetUSD.toFixed(4)} ratio=${ev.evRatio.toFixed(2)}`,
        );
        return NextResponse.json({
          success: false,
          error: `Conservative EV 미달: $${ev.expectedNetUSD.toFixed(4)} ratio=${ev.evRatio.toFixed(2)}`,
          reason: 'profitability_insufficient',
          expectedNetUSD: ev.expectedNetUSD,
          evRatio: ev.evRatio,
        });
      }
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} conservative EV OK: $${ev.expectedNetUSD.toFixed(4)} ratio=${ev.evRatio.toFixed(2)}`,
      );
    }

    // 3. Calculate precise quantities for equal USD exposure
    const shortQty = targetNotional / shortFill.fillPrice;
    const longQty = targetNotional / longFill.fillPrice;

    // 3b. v2.1: strict hedge ratio pre-check
    if (snipeConfig.useStrictHedge) {
      const shortNotionalEst = shortQty * shortFill.fillPrice;
      const longNotionalEst = longQty * longFill.fillPrice;
      const hedgeRatio = Math.abs(longNotionalEst / shortNotionalEst);
      if (hedgeRatio < HEDGE_RATIO_MIN || hedgeRatio > HEDGE_RATIO_MAX) {
        console.log(
          `[EXECUTE] ${opportunity.baseAsset} BLOCKED — hedge ratio: ${hedgeRatio.toFixed(6)} outside [${HEDGE_RATIO_MIN}, ${HEDGE_RATIO_MAX}]`,
        );
        return NextResponse.json({
          success: false,
          error: `Hedge ratio ${hedgeRatio.toFixed(6)} outside [${HEDGE_RATIO_MIN}, ${HEDGE_RATIO_MAX}]`,
          reason: 'hedge_ratio_exceeded',
          hedgeRatio,
        });
      }
    }

    // 3c. Limit prices with buffer beyond worst level (NOT fillPrice — must cover all levels)
    const PRICE_BUFFER = 0.0005; // 0.05%
    const shortLimitPrice = shortFill.worstPrice * (1 - PRICE_BUFFER); // selling: below worst bid
    const longLimitPrice = longFill.worstPrice * (1 + PRICE_BUFFER);   // buying: above worst ask

    console.log(
      `[EXECUTE] ${opportunity.baseAsset} 100% hedge plan: ` +
      `targetNotional=$${targetNotional.toFixed(2)} | ` +
      `short: qty=${shortQty.toFixed(6)} @${shortFill.fillPrice.toFixed(4)} (slip ${shortFill.slippagePercent.toFixed(4)}%) | ` +
      `long: qty=${longQty.toFixed(6)} @${longFill.fillPrice.toFixed(4)} (slip ${longFill.slippagePercent.toFixed(4)}%)`,
    );

    // 4. Execute both with pre-computed quantities (equal notional)
    const [shortResult, longResult] = await Promise.allSettled([
      openPositionExact(
        opportunity.shortExchange,
        shortConfig,
        opportunity.shortSymbol,
        'short',
        shortQty,
        shortLimitPrice,
        leverage,
        normalizedFeeOverrides,
        snipeConfig.useIocLimitOnly,
      ),
      openPositionExact(
        opportunity.longExchange,
        longConfig,
        opportunity.longSymbol,
        'long',
        longQty,
        longLimitPrice,
        leverage,
        normalizedFeeOverrides,
        snipeConfig.useIocLimitOnly,
      ),
    ]);

    const shortOk = shortResult.status === 'fulfilled';
    const longOk = longResult.status === 'fulfilled';
    const shortFailure = shortResult.status === 'rejected' ? shortResult.reason : undefined;
    const longFailure = longResult.status === 'rejected' ? longResult.reason : undefined;
    const shortPartial = shortFailure ? getPartialExecution(shortFailure) : null;
    const longPartial = longFailure ? getPartialExecution(longFailure) : null;

    let rollbackError: string | undefined;
    if (!shortOk || !longOk) {
      rollbackError = await rollbackExecutedLegs([
        ...(shortOk ? [{
          label: 'short',
          exchange: opportunity.shortExchange,
          config: shortConfig,
          symbol: opportunity.shortSymbol,
          side: 'short' as const,
          execution: shortResult.value,
          failureReason: `paired leg failed: ${getErrorMessage(longFailure)}`,
        }] : []),
        ...(!shortOk && shortPartial ? [{
          label: 'short_partial',
          exchange: opportunity.shortExchange,
          config: shortConfig,
          symbol: opportunity.shortSymbol,
          side: 'short' as const,
          execution: shortPartial,
          failureReason: getErrorMessage(shortFailure),
        }] : []),
        ...(longOk ? [{
          label: 'long',
          exchange: opportunity.longExchange,
          config: longConfig,
          symbol: opportunity.longSymbol,
          side: 'long' as const,
          execution: longResult.value,
          failureReason: `paired leg failed: ${getErrorMessage(shortFailure)}`,
        }] : []),
        ...(!longOk && longPartial ? [{
          label: 'long_partial',
          exchange: opportunity.longExchange,
          config: longConfig,
          symbol: opportunity.longSymbol,
          side: 'long' as const,
          execution: longPartial,
          failureReason: getErrorMessage(longFailure),
        }] : []),
      ]);
    }

    // Hedge balance check — trim excess side via shared helper
    let hedgeTrimNote: string | undefined;
    if (shortOk && longOk) {
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} notional balance: ` +
        `short=$${shortResult.value.filledNotional.toFixed(2)} long=$${longResult.value.filledNotional.toFixed(2)} ` +
        `diff=$${Math.abs(shortResult.value.filledNotional - longResult.value.filledNotional).toFixed(2)}`,
      );

      try {
        const trimResult = await rebalanceExecutedHedge({
          shortExchange: opportunity.shortExchange,
          longExchange: opportunity.longExchange,
          shortConfig,
          longConfig,
          shortSymbol: opportunity.shortSymbol,
          longSymbol: opportunity.longSymbol,
          shortEntry: shortResult.value,
          longEntry: longResult.value,
          useStrictHedge: snipeConfig.useStrictHedge,
          feeOverrides: normalizedFeeOverrides,
        });
        if (trimResult.trimmed) {
          hedgeTrimNote = trimResult.detail;
          console.log(`[EXECUTE] ${opportunity.baseAsset} hedge trim: ${hedgeTrimNote}`);
        }
      } catch (trimErr) {
        hedgeTrimNote = `헤지 트림 실패: ${(trimErr as Error).message} — 수동 확인 필요`;
        console.error(`[EXECUTE] ${opportunity.baseAsset} trim error:`, trimErr);
      }
    }

    if (shortOk && longOk) {
      upsertServerPositionMeta([
        {
          key: makeServerPositionKey(opportunity.shortExchange, opportunity.shortSymbol, 'short'),
          meta: {
            pairId,
            positionType: 'hedge_short',
            openedAt: Date.now(),
            entryFee: shortResult.value.estimatedFee,
            entryOrderLiquidity: shortResult.value.liquidity,
            entryFilledNotional: shortResult.value.filledNotional,
          },
        },
        {
          key: makeServerPositionKey(opportunity.longExchange, opportunity.longSymbol, 'long'),
          meta: {
            pairId,
            positionType: 'hedge_long',
            openedAt: Date.now(),
            entryFee: longResult.value.estimatedFee,
            entryOrderLiquidity: longResult.value.liquidity,
            entryFilledNotional: longResult.value.filledNotional,
          },
        },
      ]);
    }

    const expectedTotalRoundTripFees = shortOk && longOk
      ? shortResult.value.estimatedFee
        + longResult.value.estimatedFee
        + (shortResult.value.filledNotional * resolveRuntimeFee(opportunity.shortExchange, 'taker', normalizedFeeOverrides))
        + (longResult.value.filledNotional * resolveRuntimeFee(opportunity.longExchange, 'taker', normalizedFeeOverrides))
      : undefined;

    return NextResponse.json({
      success: shortOk && longOk,
      short: shortOk
        ? { success: true, data: shortResult.value }
        : { success: false, error: getErrorMessage(shortFailure) },
      long: longOk
        ? { success: true, data: longResult.value }
        : { success: false, error: getErrorMessage(longFailure) },
      rollback: rollbackError,
      hedgeTrim: hedgeTrimNote,
      pairId,
      expectedTotalRoundTripFees,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

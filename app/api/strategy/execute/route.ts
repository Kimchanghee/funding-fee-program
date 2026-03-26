import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, ApiConfig, ArbitrageOpportunity, FeeOverrides } from '@/lib/types';
import { SUPPORTED_EXCHANGES, getExchangeFee, calcHedgedNetSpreadPercent, hasValidFeeOverrides, sanitizeFeeOverrides } from '@/lib/types';
import {
  openPositionExact,
  fetchMarketFillPrice,
  closePosition,
  getPartialExecution,
  type ExecutedOrderSummary,
} from '@/lib/exchanges';
import { loadAllServerApiConfigs } from '@/lib/serverKeyStore';
import { makeServerPositionKey, upsertServerPositionMeta } from '@/lib/serverPositionMeta';

function isValidApiConfig(config: unknown): config is ApiConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;
  return typeof c.apiKey === 'string' && c.apiKey.length > 0
    && typeof c.secret === 'string' && c.secret.length > 0;
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
    };

    const { opportunity, investmentUSDT, leverage, apiConfigs, feeOverrides } = body;
    const normalizedFeeOverrides = sanitizeFeeOverrides(feeOverrides);
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

    // 서버 측 암호화 키 저장소 우선, fallback으로 클라이언트 전송 키 사용
    const serverConfigs = loadAllServerApiConfigs();
    const shortConfig = serverConfigs[opportunity.shortExchange] ?? apiConfigs?.[opportunity.shortExchange];
    const longConfig = serverConfigs[opportunity.longExchange] ?? apiConfigs?.[opportunity.longExchange];

    if (!isValidApiConfig(shortConfig) || !isValidApiConfig(longConfig)) {
      return NextResponse.json(
        { success: false, error: 'Missing or invalid API credentials for one or both exchanges' },
        { status: 400 },
      );
    }

    // ── 100% Hedge: 양쪽 오더북 동시 조회 → 동일 notional 수량 계산 → 동시 실행 ──
    const targetNotional = investmentUSDT * leverage;

    // 1. Pre-fetch orderbooks from both exchanges simultaneously
    const [shortFill, longFill] = await Promise.all([
      fetchMarketFillPrice(opportunity.shortExchange, opportunity.shortSymbol, 'sell', targetNotional),
      fetchMarketFillPrice(opportunity.longExchange, opportunity.longSymbol, 'buy', targetNotional),
    ]);

    // 2a. Slippage guard — 1.5% 이상이면 거래 차단
    const MAX_SLIPPAGE_PCT = 1.5;
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

    // 2b. Cross-exchange entry gap guard — 거래소 간 가격 괴리도 슬리피지와 동일 기준 적용
    const entryGapPct = ((longFill.fillPrice - shortFill.fillPrice) / shortFill.fillPrice) * 100;
    if (Math.abs(entryGapPct) > MAX_SLIPPAGE_PCT) {
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} BLOCKED — 거래소 간 가격 괴리 초과: ` +
        `entryGap=${entryGapPct.toFixed(4)}% > ${MAX_SLIPPAGE_PCT}% | ` +
        `short(${opportunity.shortExchange})=${shortFill.fillPrice} long(${opportunity.longExchange})=${longFill.fillPrice}`,
      );
      return NextResponse.json({
        success: false,
        error: `거래소 간 가격 괴리 초과: ${entryGapPct.toFixed(4)}% > ${MAX_SLIPPAGE_PCT}%`,
        reason: 'entry_gap_exceeded',
        entryGapPct,
        maxSlippage: MAX_SLIPPAGE_PCT,
      });
    }

    // 2c. Pre-execution profitability gate — 계약 수량 매칭 기반 수익성 재검증
    const execPriceRatio = longFill.fillPrice / shortFill.fillPrice;
    const realNetSpread = calcHedgedNetSpreadPercent(
      opportunity.shortRatePercent,
      opportunity.longRatePercent,
      execPriceRatio,
      opportunity.shortExchange,
      opportunity.longExchange,
      'taker',
      normalizedFeeOverrides,
    );

    if (realNetSpread <= 0) {
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} BLOCKED — 실시간 수익성 미달: ` +
        `스프레드=${opportunity.spreadPercent.toFixed(4)}% 진입갭=${entryGapPct.toFixed(4)}% ` +
        `priceRatio=${execPriceRatio.toFixed(6)} → 순수익=${realNetSpread.toFixed(4)}%`,
      );
      return NextResponse.json({
        success: false,
        error: `실시간 수익성 미달: 순스프레드 ${realNetSpread.toFixed(4)}% ≤ 0 (진입갭 ${entryGapPct.toFixed(4)}%)`,
        reason: 'profitability_insufficient',
        entryGapPct,
        priceRatio: execPriceRatio,
        realNetSpread,
      });
    }

    console.log(
      `[EXECUTE] ${opportunity.baseAsset} profitability OK: ` +
      `순스프레드=${realNetSpread.toFixed(4)}% (진입갭=${entryGapPct.toFixed(4)}%)`,
    );

    // 3. Calculate precise quantities for equal USD exposure
    const shortQty = targetNotional / shortFill.fillPrice;
    const longQty = targetNotional / longFill.fillPrice;

    // 3. Limit prices with buffer beyond worst level (NOT fillPrice — must cover all levels)
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

    // Hedge balance check — trim excess side if notional diff > 2%
    let hedgeTrimNote: string | undefined;
    if (shortOk && longOk) {
      const shortNotional = shortResult.value.filledNotional;
      const longNotional = longResult.value.filledNotional;
      const diff = Math.abs(shortNotional - longNotional);
      const maxNotional = Math.max(shortNotional, longNotional);
      const diffPercent = (diff / maxNotional) * 100;
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} notional balance: ` +
        `short=$${shortNotional.toFixed(2)} long=$${longNotional.toFixed(2)} ` +
        `diff=$${diff.toFixed(2)} (${diffPercent.toFixed(3)}%)`,
      );

      // 2% 초과 불균형 시 초과분 부분 청산으로 보정
      if (diffPercent > 2) {
        try {
          const minNotional = Math.min(shortNotional, longNotional);
          if (shortNotional > longNotional) {
            // 숏이 더 큼 — 숏 초과분 청산
            const excessQty = (shortNotional - minNotional) / shortResult.value.price;
            await closePosition(
              opportunity.shortExchange, shortConfig,
              opportunity.shortSymbol, 'short', excessQty, normalizedFeeOverrides,
            );
            hedgeTrimNote = `숏 초과분 $${(shortNotional - minNotional).toFixed(2)} 트림 완료`;
          } else {
            // 롱이 더 큼 — 롱 초과분 청산
            const excessQty = (longNotional - minNotional) / longResult.value.price;
            await closePosition(
              opportunity.longExchange, longConfig,
              opportunity.longSymbol, 'long', excessQty, normalizedFeeOverrides,
            );
            hedgeTrimNote = `롱 초과분 $${(longNotional - minNotional).toFixed(2)} 트림 완료`;
          }
          console.log(`[EXECUTE] ${opportunity.baseAsset} hedge trim: ${hedgeTrimNote}`);
        } catch (trimErr) {
          hedgeTrimNote = `헤지 트림 실패: ${(trimErr as Error).message} — 수동 확인 필요`;
          console.error(`[EXECUTE] ${opportunity.baseAsset} trim error:`, trimErr);
        }
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
        + (shortResult.value.filledNotional * getExchangeFee(opportunity.shortExchange, 'taker', normalizedFeeOverrides))
        + (longResult.value.filledNotional * getExchangeFee(opportunity.longExchange, 'taker', normalizedFeeOverrides))
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

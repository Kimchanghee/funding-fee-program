import { NextRequest, NextResponse } from 'next/server';
import type { ExchangeId, ApiConfig, ArbitrageOpportunity } from '@/lib/types';
import { SUPPORTED_EXCHANGES, getHedgeFees } from '@/lib/types';
import { openPositionExact, fetchMarketFillPrice, closePosition } from '@/lib/exchanges';
import { loadAllServerApiConfigs } from '@/lib/serverKeyStore';
import { makeServerPositionKey, upsertServerPositionMeta } from '@/lib/serverPositionMeta';

function isValidApiConfig(config: unknown): config is ApiConfig {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;
  return typeof c.apiKey === 'string' && c.apiKey.length > 0
    && typeof c.secret === 'string' && c.secret.length > 0;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as {
      opportunity: ArbitrageOpportunity;
      investmentUSDT: number;
      leverage: number;
      apiConfigs: Partial<Record<ExchangeId, ApiConfig>>;
      pairId?: string;
    };

    const { opportunity, investmentUSDT, leverage, apiConfigs } = body;
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

    // 2. Pre-execution profitability gate — fresh fill price 기반 수익성 재검증
    const entryGapPct = ((longFill.fillPrice - shortFill.fillPrice) / shortFill.fillPrice) * 100;
    const hedgeFeePct = getHedgeFees(opportunity.shortExchange, opportunity.longExchange, 'taker') * 100;
    const SAFETY_MARGIN = 0.03; // 3bps
    const realNetSpread = opportunity.spreadPercent - entryGapPct * 1.5 - hedgeFeePct - SAFETY_MARGIN;

    if (realNetSpread <= 0) {
      console.log(
        `[EXECUTE] ${opportunity.baseAsset} BLOCKED — 실시간 수익성 미달: ` +
        `스프레드=${opportunity.spreadPercent.toFixed(4)}% 진입갭=${entryGapPct.toFixed(4)}% ` +
        `수수료=${hedgeFeePct.toFixed(3)}% → 순수익=${realNetSpread.toFixed(4)}%`,
      );
      return NextResponse.json({
        success: false,
        error: `실시간 수익성 미달: 순스프레드 ${realNetSpread.toFixed(4)}% ≤ 0 (진입갭 ${entryGapPct.toFixed(4)}%, 수수료 ${hedgeFeePct.toFixed(3)}%)`,
        entryGapPct,
        hedgeFeePct,
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
      ),
      openPositionExact(
        opportunity.longExchange,
        longConfig,
        opportunity.longSymbol,
        'long',
        longQty,
        longLimitPrice,
        leverage,
      ),
    ]);

    const shortOk = shortResult.status === 'fulfilled';
    const longOk = longResult.status === 'fulfilled';

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
              opportunity.shortSymbol, 'short', excessQty,
            );
            hedgeTrimNote = `숏 초과분 $${(shortNotional - minNotional).toFixed(2)} 트림 완료`;
          } else {
            // 롱이 더 큼 — 롱 초과분 청산
            const excessQty = (longNotional - minNotional) / longResult.value.price;
            await closePosition(
              opportunity.longExchange, longConfig,
              opportunity.longSymbol, 'long', excessQty,
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

    // Rollback: if one side succeeded but the other failed, close the successful side
    let rollbackError: string | undefined;
    if (shortOk && !longOk) {
      try {
        const shortData = shortResult.value;
        await closePosition(
          opportunity.shortExchange,
          shortConfig,
          opportunity.shortSymbol,
          'short',
          shortData.amount,
        );
        rollbackError = `롱 진입 실패 → 숏 포지션 롤백(청산) 완료`;
      } catch (rbErr) {
        rollbackError = `롱 진입 실패 + 숏 롤백 실패: ${(rbErr as Error).message} — 수동 청산 필요!`;
      }
    } else if (!shortOk && longOk) {
      try {
        const longData = longResult.value;
        await closePosition(
          opportunity.longExchange,
          longConfig,
          opportunity.longSymbol,
          'long',
          longData.amount,
        );
        rollbackError = `숏 진입 실패 → 롱 포지션 롤백(청산) 완료`;
      } catch (rbErr) {
        rollbackError = `숏 진입 실패 + 롱 롤백 실패: ${(rbErr as Error).message} — 수동 청산 필요!`;
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

    return NextResponse.json({
      success: shortOk && longOk,
      short: shortOk
        ? { success: true, data: shortResult.value }
        : { success: false, error: (shortResult.reason as Error).message },
      long: longOk
        ? { success: true, data: longResult.value }
        : { success: false, error: (longResult.reason as Error).message },
      rollback: rollbackError,
      hedgeTrim: hedgeTrimNote,
      pairId,
    });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: (err as Error).message },
      { status: 500 },
    );
  }
}

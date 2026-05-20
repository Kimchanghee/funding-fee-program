'use client';

import { useState, useEffect } from 'react';
import { X, DollarSign, TrendingUp, Info, Send } from 'lucide-react';
import { useFundingStore } from '@/store/fundingStore';
import { estimateProfit } from '@/lib/opportunities';
import { DEFAULT_CONFIRMED_SNIPE_CONFIG, MAX_ROUND_TRIP_IMPACT_BPS, type ConfirmedSnipeConfig } from '@/lib/types';
import { fmtNum, fmtPctOrInfinity, fmtUsdOrInfinity, isInfiniteProfitDisplay } from '@/lib/format';
import { getTelegramConfig, saveTelegramConfig, sendTelegramMessage } from '@/lib/telegram';

export default function StrategyPanel() {
  const { strategyConfig, setStrategyConfig, setShowStrategyPanel, opportunities, realSpreads } = useFundingStore();
  const maxSlippagePercent = strategyConfig.maxSlippagePercent ?? 1.5;
  const minVolume24hUSD = strategyConfig.minVolume24hUSD ?? 7_500_000;
  const best = opportunities[0];
  const realSpread = best ? (realSpreads[best.id ?? ''] ?? realSpreads[best.baseAsset]) : null;
  const hasRealSpread = !!(realSpread && Date.now() - realSpread.updatedAt < 30_000);
  const effectiveBest = best && hasRealSpread && realSpread
    ? { ...best, spread: realSpread.effectiveSpread / 100, spreadPercent: realSpread.effectiveSpread }
    : best;
  const measuredImpactPercent = hasRealSpread && realSpread
    ? Math.max(0, (realSpread.shortSlippage ?? 0) + (realSpread.longSlippage ?? 0))
    : 0;
  const snipeCfg = strategyConfig.confirmedSnipeConfig;
  const fallbackImpactPercent = snipeCfg?.useImpactGuards
    ? ((snipeCfg.maxRoundTripImpactBps ?? MAX_ROUND_TRIP_IMPACT_BPS) / 200)
    : ((snipeCfg?.targetImpactBps ?? 4) / 100);
  const impactPercent = measuredImpactPercent > 0 ? measuredImpactPercent : fallbackImpactPercent;

  const profit = effectiveBest
    ? estimateProfit(effectiveBest, strategyConfig.investmentUSDT, strategyConfig.leverage, {
      skipFees: false,
      feeOverrides: strategyConfig.feeOverrides,
      paybackOverrides: strategyConfig.paybackOverrides,
      useDriftBuffer: strategyConfig.confirmedSnipeConfig?.useDriftBuffer,
      entryImpactPercent: impactPercent,
      exitImpactPercent: impactPercent,
    })
    : null;

  return (
    <div
      className="strategy-panel-overlay"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        background: 'rgba(0,0,0,0.75)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={() => setShowStrategyPanel(false)}
    >
      <div
        className="glass-card animate-slide-in strategy-panel"
        style={{ width: 460, maxWidth: '95vw', maxHeight: '90vh', overflow: 'auto' }}
        onClick={e => e.stopPropagation()}
      >
        {/* Title */}
        <div className="strategy-panel-header" style={{ padding: '20px 24px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <TrendingUp size={16} color="var(--color-success)" />
            <span style={{ fontSize: 15, fontWeight: 700 }}>전략 설정</span>
          </div>
          <button className="btn btn-ghost" style={{ padding: '4px 6px' }} onClick={() => setShowStrategyPanel(false)}>
            <X size={16} />
          </button>
        </div>

        <div className="strategy-panel-body" style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 20 }}>
          {/* Investment */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
              <DollarSign size={12} /> 포지션당 투자금 (USDT)
            </label>
            <input
              className="input-field"
              type="number"
              min={10}
              max={1000000}
              step={100}
              value={strategyConfig.investmentUSDT}
              onChange={e => setStrategyConfig({ investmentUSDT: Number(e.target.value) })}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              총 투자금: <strong style={{ color: 'var(--color-text)' }}>${(strategyConfig.investmentUSDT * 2).toLocaleString()}</strong> (롱+숏 양방향)
            </div>
          </div>

          {/* Leverage */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
              레버리지: <strong style={{ color: 'var(--color-primary)' }}>{strategyConfig.leverage}x</strong>
            </label>
            <input
              type="range"
              min={1}
              max={20}
              step={1}
              value={strategyConfig.leverage}
              onChange={e => setStrategyConfig({ leverage: Number(e.target.value) })}
              style={{ width: '100%', accentColor: 'var(--color-primary)', cursor: 'pointer' }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--color-text-muted)' }}>
              <span>1x (안전)</span>
              <span>5x (권장)</span>
              <span>20x (고위험)</span>
            </div>
            <div style={{ fontSize: 11, color: '#f59e0b', marginTop: 6 }}>
              ⚠️ 레버리지가 높을수록 청산 위험이 증가합니다. 5x 이하를 권장합니다.
            </div>
          </div>

          {/* Min spread */}
          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
              최소 스프레드 (%): <strong style={{ color: 'var(--color-text)' }}>{strategyConfig.minSpreadPercent}%</strong>
            </label>
            <input
              className="input-field"
              type="number"
              min={0.01}
              max={1}
              step={0.01}
              value={strategyConfig.minSpreadPercent}
              onChange={e => setStrategyConfig({ minSpreadPercent: Number(e.target.value) })}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              이 값 이상일 때만 자동 진입 알림/실행
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
              최대 슬리피지 (%): <strong style={{ color: 'var(--color-text)' }}>{maxSlippagePercent}%</strong>
            </label>
            <input
              className="input-field"
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={maxSlippagePercent}
              onChange={e => setStrategyConfig({ maxSlippagePercent: Number(e.target.value) })}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              진입 전 오더북 검증에서 이 값 초과 시 차단
            </div>
          </div>

          <div>
            <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-muted)', marginBottom: 6, display: 'block' }}>
              최소 24h 거래량 (USD): <strong style={{ color: 'var(--color-text)' }}>${minVolume24hUSD.toLocaleString()}</strong>
            </label>
            <input
              className="input-field"
              type="number"
              min={0}
              max={1000000000}
              step={500000}
              value={minVolume24hUSD}
              onChange={e => setStrategyConfig({ minVolume24hUSD: Number(e.target.value) })}
            />
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 4 }}>
              저유동성 종목 제외 기준 (0 입력 시 비활성)
            </div>
          </div>

          {/* Compound investing toggle */}
          <div style={{ padding: 16, borderRadius: 10, background: 'var(--bg-accent)', border: '1px solid var(--color-border)' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--color-text)', marginBottom: 12 }}>
              투자 방식
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {([
                { label: '단리 (고정 투자금)', value: false, color: '#10b981', desc: '매번 같은 금액으로 진입' },
                { label: '복리 (수익 재투자)', value: true, color: '#a78bfa', desc: '수익을 포함해 투자금 증가' },
              ] as const).map(({ label, value, color, desc }) => (
                <button
                  key={label}
                  onClick={() => setStrategyConfig({ compoundInvesting: value })}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: 8,
                    border: `1px solid ${strategyConfig.compoundInvesting === value ? color : 'var(--color-border)'}`,
                    background: strategyConfig.compoundInvesting === value ? `${color}15` : 'transparent',
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: strategyConfig.compoundInvesting === value ? color : 'var(--color-text-muted)' }}>
                    {label}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 2 }}>{desc}</div>
                </button>
              ))}
            </div>
          </div>

          {/* v2.1 Confirmed Snipe Settings */}
          <ConfirmedSnipeSettings
            config={strategyConfig.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG}
            onChange={(patch) => {
              const prev = strategyConfig.confirmedSnipeConfig ?? DEFAULT_CONFIRMED_SNIPE_CONFIG;
              setStrategyConfig({ confirmedSnipeConfig: { ...prev, ...patch } });
            }}
          />

          {/* Telegram Settings */}
          <TelegramSettings />

          {/* Profit preview */}
          {profit && best && (
            <div style={{ padding: 16, borderRadius: 10, background: 'rgba(16,185,129,0.06)', border: '1px solid rgba(16,185,129,0.2)' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#10b981', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Info size={12} /> 현재 최적 기회 기준 예상 수익 ({best.baseAsset})
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[
                  { label: '1h 순수익', value: profit.per1h },
                  { label: '4h 순수익', value: profit.per4h },
                  { label: '8h 순수익', value: profit.netPerFunding },
                  { label: '일 순수익 (3회)', value: profit.perDay },
                  { label: '주 순수익', value: profit.perWeek },
                  { label: '월 순수익', value: profit.perMonth },
                ].map(({ label, value }) => (
                  <div key={label} style={{ background: 'var(--bg-accent)', borderRadius: 8, padding: '8px 12px' }}>
                    <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{label}</div>
                    <div className="mono" style={{ fontSize: 15, fontWeight: 700, color: '#10b981' }}>
                      {fmtUsdOrInfinity(value, 2, { showPlus: false })}
                    </div>
                  </div>
                ))}
                <div style={{ gridColumn: '1 / -1', background: 'rgba(16,185,129,0.08)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: 8, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>연 순수익</div>
                  <div className="mono" style={{ fontSize: 18, fontWeight: 800, color: '#10b981' }}>
                    {fmtUsdOrInfinity(profit.perYear, 2, { showPlus: false })}
                  </div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 8 }}>
                스프레드: <strong style={{ color: '#10b981' }}>+{fmtNum(effectiveBest?.spreadPercent ?? best.spreadPercent, 4)}%</strong>{hasRealSpread ? ' (실측)' : ''} •
                연환산: <strong style={{ color: '#10b981' }}>{fmtPctOrInfinity(profit.roiPerYear, 1, { showPlus: false, forceInfinity: isInfiniteProfitDisplay(profit.perYear) })}</strong>
              </div>
            </div>
          )}

          <button
            className="btn btn-success"
            style={{ padding: '12px 24px', justifyContent: 'center' }}
            onClick={() => setShowStrategyPanel(false)}
          >
            저장 완료
          </button>
        </div>
      </div>
    </div>
  );
}

/** 텔레그램 알림 설정 서브 컴포넌트 */
function TelegramSettings() {
  const [config, setConfig] = useState({ botToken: '', chatId: '', enabled: false });
  const [testStatus, setTestStatus] = useState<'idle' | 'sending' | 'ok' | 'fail'>('idle');

  useEffect(() => {
    const saved = getTelegramConfig();
    setConfig(saved);
    if (saved.enabled && saved.botToken && saved.chatId) {
      saveTelegramConfig(saved);
    }
  }, []);

  const handleSave = (patch: Partial<typeof config>) => {
    const next = { ...config, ...patch };
    setConfig(next);
    saveTelegramConfig(next);
  };

  const handleTest = async () => {
    setTestStatus('sending');
    const ok = await sendTelegramMessage('✅ 펀딩피 아비트라지 알림이 연결되었습니다!');
    setTestStatus(ok ? 'ok' : 'fail');
    setTimeout(() => setTestStatus('idle'), 3000);
  };

  return (
    <div style={{ padding: 16, borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#3b82f6', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Send size={12} /> 텔레그램 알림
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11 }}>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={e => handleSave({ enabled: e.target.checked })}
            style={{ accentColor: '#3b82f6' }}
          />
          <span style={{ color: config.enabled ? '#3b82f6' : 'var(--color-text-muted)' }}>
            {config.enabled ? '활성' : '비활성'}
          </span>
        </label>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <label style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'block', marginBottom: 4 }}>Bot Token</label>
          <input
            type="password"
            placeholder="123456789:ABCdefGHI..."
            value={config.botToken}
            onChange={e => handleSave({ botToken: e.target.value })}
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6, fontSize: 12,
              background: 'var(--bg-accent)', border: '1px solid var(--border-primary)',
              color: 'var(--color-text)',
            }}
          />
        </div>
        <div>
          <label style={{ fontSize: 10, color: 'var(--color-text-muted)', display: 'block', marginBottom: 4 }}>Chat ID</label>
          <input
            type="text"
            placeholder="-1001234567890"
            value={config.chatId}
            onChange={e => handleSave({ chatId: e.target.value })}
            style={{
              width: '100%', padding: '6px 10px', borderRadius: 6, fontSize: 12,
              background: 'var(--bg-accent)', border: '1px solid var(--border-primary)',
              color: 'var(--color-text)',
            }}
          />
        </div>
        <button
          onClick={handleTest}
          disabled={!config.enabled || !config.botToken || !config.chatId || testStatus === 'sending'}
          style={{
            padding: '6px 12px', borderRadius: 6, fontSize: 11, fontWeight: 600,
            background: testStatus === 'ok' ? '#10b981' : testStatus === 'fail' ? '#ef4444' : '#3b82f6',
            color: '#fff', border: 'none', cursor: 'pointer',
            opacity: (!config.enabled || !config.botToken || !config.chatId) ? 0.4 : 1,
          }}
        >
          {testStatus === 'sending' ? '전송 중...' : testStatus === 'ok' ? '연결 성공!' : testStatus === 'fail' ? '실패' : '테스트 메시지 전송'}
        </button>
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginTop: 8 }}>
        펀딩 수익 수령, 스나이프 완료, 거래소 잔고 부족(평균 50% 이하) 시 알림
      </div>
    </div>
  );
}

/** v2.1 Confirmed Snipe 설정 */
function ConfirmedSnipeSettings({
  config,
  onChange,
}: {
  config: ConfirmedSnipeConfig;
  onChange: (patch: Partial<ConfirmedSnipeConfig>) => void;
}) {
  const toggleStyle = (enabled: boolean): React.CSSProperties => ({
    width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', position: 'relative',
    background: enabled ? '#3b82f6' : 'var(--bg-accent)',
    transition: 'background 0.2s',
  });
  const dotStyle = (enabled: boolean): React.CSSProperties => ({
    width: 16, height: 16, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2,
    left: enabled ? 18 : 2, transition: 'left 0.2s',
    boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
  });

  const toggles: Array<{ key: keyof ConfirmedSnipeConfig; label: string; desc: string }> = [
    { key: 'useConfirmedClose', label: 'Confirmed Close', desc: '펀딩 정산 확인 후 청산' },
    { key: 'useIocLimitOnly', label: 'IOC-Limit Only', desc: 'Post-Only 제거, IOC 전용 진입' },
    { key: 'useDynamicNotional', label: 'Dynamic Notional', desc: '오더북 깊이 기반 동적 노셔널' },
    { key: 'useImpactGuards', label: 'Impact Guards', desc: 'impact bps 기반 가드 (슬리피지 % 대체)' },
    { key: 'useStrictHedge', label: 'Strict Hedge', desc: '헷지 비율 0.998~1.002, mismatch 0.20%' },
    { key: 'useDriftBuffer', label: 'Drift Buffer', desc: '펀딩레이트 변동 보수적 반영' },
  ];

  return (
    <div style={{ padding: 16, borderRadius: 10, background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.15)' }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: '#3b82f6', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
        <Info size={12} /> v2.1 Confirmed Snipe
      </div>
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginBottom: 12 }}>
        모든 토글 기본 OFF. 단, 거래소 프로파일 기반 진입 타이밍과 Tier C 필터는 공통 적용됩니다.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toggles.map(({ key, label, desc }) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <button
              style={toggleStyle(!!config[key])}
              onClick={() => onChange({ [key]: !config[key] })}
            >
              <div style={dotStyle(!!config[key])} />
            </button>
            <div>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text)' }}>{label}</div>
              <div style={{ fontSize: 10, color: 'var(--color-text-muted)' }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>
      {config.useDynamicNotional && (
        <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
          <label style={{ fontSize: 11, color: 'var(--color-text-muted)', whiteSpace: 'nowrap' }}>노셔널 상한 ($)</label>
          <input
            type="number"
            value={config.dynamicNotionalCap}
            onChange={e => onChange({ dynamicNotionalCap: Math.max(500, Math.min(300000, Number(e.target.value))) })}
            style={{
              width: 80, padding: '4px 8px', borderRadius: 6, fontSize: 12,
              background: 'var(--bg-accent)', border: '1px solid var(--border-primary)',
              color: 'var(--color-text)',
            }}
            min={500}
            max={300000}
            step={500}
          />
        </div>
      )}
    </div>
  );
}

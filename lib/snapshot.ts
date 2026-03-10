import { writeFile, mkdir } from 'fs/promises';
import path from 'path';

const SNAPSHOT_DIR = path.join(process.cwd(), 'data', 'snapshots');

// 마지막 저장한 1위 코인 기록 (순위 변경 감지용)
let lastTopAsset: string | null = null;

/**
 * 펀딩률 + 기회 스냅샷 저장
 * 1위 코인이 바뀔 때마다 자동 저장
 */
export async function saveSnapshotIfRankChanged(
  rates: unknown[],
  opportunities: unknown[],
) {
  if (opportunities.length === 0) return;

  const top = opportunities[0] as { baseAsset: string; spreadPercent: number };
  const topAsset = top.baseAsset;

  // 순위 변경 감지
  if (topAsset === lastTopAsset) return;

  const prevTop = lastTopAsset;
  lastTopAsset = topAsset;

  // 첫 실행 시에는 저장 (초기 기록)
  // 이후에는 순위 변경 시에만 저장

  const now = new Date();
  const timestamp = now.toISOString()
    .replace(/T/, '-')
    .replace(/:/g, '-')
    .replace(/\.\d+Z$/, '');
  // 결과: 2026-03-11-14-30-25

  const filename = `${timestamp}.json`;
  const filepath = path.join(SNAPSHOT_DIR, filename);

  const snapshot = {
    savedAt: now.toISOString(),
    trigger: prevTop ? `순위변경: ${prevTop} → ${topAsset}` : `초기기록: 1위 ${topAsset}`,
    topOpportunity: {
      baseAsset: top.baseAsset,
      spreadPercent: top.spreadPercent,
    },
    opportunityCount: opportunities.length,
    rateCount: rates.length,
    opportunities: opportunities.slice(0, 20), // 상위 20개만
    rates,
  };

  try {
    await mkdir(SNAPSHOT_DIR, { recursive: true });
    await writeFile(filepath, JSON.stringify(snapshot, null, 2), 'utf-8');
    console.log(`[Snapshot] ${filename} 저장됨 (${snapshot.trigger})`);
  } catch (err) {
    console.error('[Snapshot] 저장 실패:', (err as Error).message);
  }
}

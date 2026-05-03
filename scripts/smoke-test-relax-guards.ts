/**
 * Smoke test for the relax-guards feature flags.
 *
 * Verifies pure logic — no network, no exchanges. Run with:
 *   npx tsx scripts/smoke-test-relax-guards.ts
 *
 * Exits 0 on pass, 1 on any failure. Designed for CI / pre-merge sanity.
 */

import {
  getActiveLiveFundingTimeDriftMs,
  getRelaxGuardsFlags,
  isAcceptableFundingShift,
  RELAXED_LIVE_FUNDING_TIME_DRIFT_MS,
} from '../lib/relaxGuardsConfig';

interface TestCase {
  name: string;
  run: () => void;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

const ONE_MIN = 60_000;
const TEN_MIN = 600_000;
const ONE_HOUR = 60 * 60 * 1000;
const FOUR_HOUR = 4 * 60 * 60 * 1000;
const EIGHT_HOUR = 8 * 60 * 60 * 1000;

const cases: TestCase[] = [
  {
    name: 'flags default to OFF when no env vars set',
    run: () => {
      delete process.env.RELAX_FUNDING_WINDOW;
      delete process.env.ORDERBOOK_DEFER_ENABLED;
      const flags = getRelaxGuardsFlags();
      assert(flags.relaxFundingWindow === false, 'relaxFundingWindow should default false');
      assert(flags.orderbookDeferEnabled === false, 'orderbookDeferEnabled should default false');
    },
  },
  {
    name: 'flags parse "true" / "1" / "yes" as on, anything else as off',
    run: () => {
      for (const v of ['true', 'TRUE', '1', 'yes', 'on']) {
        process.env.RELAX_FUNDING_WINDOW = v;
        assert(getRelaxGuardsFlags().relaxFundingWindow === true, `should parse "${v}" as true`);
      }
      for (const v of ['false', '0', 'no', '', 'random']) {
        process.env.RELAX_FUNDING_WINDOW = v;
        assert(getRelaxGuardsFlags().relaxFundingWindow === false, `should parse "${v}" as false`);
      }
      delete process.env.RELAX_FUNDING_WINDOW;
    },
  },
  {
    name: 'getActiveLiveFundingTimeDriftMs returns baseline when flag OFF',
    run: () => {
      delete process.env.RELAX_FUNDING_WINDOW;
      assert(getActiveLiveFundingTimeDriftMs(ONE_MIN) === ONE_MIN, 'should pass through baseline');
      assert(getActiveLiveFundingTimeDriftMs(123) === 123, 'should pass through arbitrary baseline');
    },
  },
  {
    name: 'getActiveLiveFundingTimeDriftMs returns 10m when flag ON',
    run: () => {
      process.env.RELAX_FUNDING_WINDOW = 'true';
      assert(getActiveLiveFundingTimeDriftMs(ONE_MIN) === RELAXED_LIVE_FUNDING_TIME_DRIFT_MS,
        'should bump to 10m');
      assert(getActiveLiveFundingTimeDriftMs(123) === RELAXED_LIVE_FUNDING_TIME_DRIFT_MS,
        'should ignore baseline when relaxed');
      delete process.env.RELAX_FUNDING_WINDOW;
    },
  },
  {
    name: 'isAcceptableFundingShift strict: matches single cycle within tolerance',
    run: () => {
      // 8h shift, 8h interval, 60s tolerance -> accept
      assert(isAcceptableFundingShift(EIGHT_HOUR, EIGHT_HOUR, ONE_MIN), 'exact 8h match');
      // 8h + 30s shift, 60s tolerance -> accept
      assert(isAcceptableFundingShift(EIGHT_HOUR + 30_000, EIGHT_HOUR, ONE_MIN), 'within 60s');
      // 8h + 90s shift, 60s tolerance -> reject
      assert(!isAcceptableFundingShift(EIGHT_HOUR + 90_000, EIGHT_HOUR, ONE_MIN), 'outside 60s rejected');
    },
  },
  {
    name: 'isAcceptableFundingShift strict: 4h shift on 8h interval is REJECTED',
    run: () => {
      // The 04-30 PRL failure: long shifted 4h, opportunity is 8h cycle.
      // Strict mode must reject — that is the existing safety behavior.
      assert(!isAcceptableFundingShift(FOUR_HOUR, EIGHT_HOUR, ONE_MIN), '4h on 8h strict reject');
      assert(!isAcceptableFundingShift(ONE_HOUR, EIGHT_HOUR, ONE_MIN), '1h on 8h strict reject');
    },
  },
  {
    name: 'isAcceptableFundingShift relaxed: 4h shift on 8h interval is ACCEPTED',
    run: () => {
      // Same inputs as above but allowMultiCycle=true.
      assert(
        isAcceptableFundingShift(FOUR_HOUR, EIGHT_HOUR, TEN_MIN, { allowMultiCycle: true }),
        '4h on 8h relaxed accept',
      );
      assert(
        isAcceptableFundingShift(ONE_HOUR, EIGHT_HOUR, TEN_MIN, { allowMultiCycle: true }),
        '1h on 8h relaxed accept',
      );
      // Still reject something that isn't any standard cycle.
      assert(
        !isAcceptableFundingShift(2 * 60 * 60 * 1000 + 60_000, EIGHT_HOUR, ONE_MIN, { allowMultiCycle: true }),
        'arbitrary 2h+ shift should still reject',
      );
    },
  },
  {
    name: 'isAcceptableFundingShift rejects negative/NaN safely',
    run: () => {
      assert(!isAcceptableFundingShift(-1, EIGHT_HOUR, ONE_MIN), 'negative rejected');
      assert(!isAcceptableFundingShift(NaN, EIGHT_HOUR, ONE_MIN), 'NaN rejected');
    },
  },
];

let passed = 0;
let failed = 0;
for (const tc of cases) {
  try {
    tc.run();
    console.log(`  PASS  ${tc.name}`);
    passed += 1;
  } catch (err) {
    console.error(`  FAIL  ${tc.name}\n        ${(err as Error).message}`);
    failed += 1;
  }
}

console.log(`\n${passed} passed, ${failed} failed (${cases.length} total)`);
process.exit(failed === 0 ? 0 : 1);

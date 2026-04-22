const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const BASE_URL = process.env.WATCHDOG_BASE_URL || 'http://127.0.0.1:3000';
const TARGET_PROCESS = process.env.WATCHDOG_TARGET_PROCESS || 'funding-fee-program';
const CHECK_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 20000);
const HTTP_TIMEOUT_MS = Number(process.env.WATCHDOG_HTTP_TIMEOUT_MS || 10000);
const APP_FAIL_THRESHOLD = Number(process.env.WATCHDOG_APP_FAIL_THRESHOLD || 3);
const DATA_FAIL_THRESHOLD = Number(process.env.WATCHDOG_DATA_FAIL_THRESHOLD || 6);
const STARTUP_GRACE_MS = Number(process.env.WATCHDOG_STARTUP_GRACE_MS || 90000);
const RESTART_COOLDOWN_MS = Number(process.env.WATCHDOG_RESTART_COOLDOWN_MS || 300000);
const DATA_PROBE_INTERVAL_MS = Number(process.env.WATCHDOG_DATA_PROBE_INTERVAL_MS || 60000);
const FUNDING_STALL_THRESHOLD_MS = Number(process.env.WATCHDOG_FUNDING_STALL_THRESHOLD_MS || 1200000);
const EXPECTED_MODE_RAW = (process.env.WATCHDOG_EXPECTED_MODE || 'either').toLowerCase();

const SCHEDULER_PATH = '/api/scheduler';
const SIM_SCHEDULER_PATH = '/api/sim-scheduler';
const HEALTH_PATH = '/api/market-data-health';
const FUNDING_PROBE_PATH = '/api/funding-rates?exchanges=binance';
const ORDERBOOK_PROBE_PATH = '/api/exchanges/binance/orderbook?symbol=BTC%2FUSDT%3AUSDT&side=buy&notional=1000';

const PM2_CMD = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';

let appFailCount = 0;
let dataFailCount = 0;
let lastDataProbeAt = 0;
let lastRestartAt = 0;
const startedAt = Date.now();

function normalizeExpectedMode(value) {
  if (value === 'real' || value === 'sim' || value === 'both' || value === 'either') {
    return value;
  }
  return 'either';
}

const EXPECTED_MODE = normalizeExpectedMode(EXPECTED_MODE_RAW);

function isExpectedModeActive(realActive, simActive) {
  switch (EXPECTED_MODE) {
    case 'real':
      return realActive;
    case 'sim':
      return simActive;
    case 'both':
      return realActive && simActive;
    case 'either':
    default:
      return realActive || simActive;
  }
}

function formatTimestamp() {
  const date = new Date();
  const intl = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = intl.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '00';
  const day = parts.find((part) => part.type === 'day')?.value ?? '00';
  const hour = parts.find((part) => part.type === 'hour')?.value ?? '00';
  const minute = parts.find((part) => part.type === 'minute')?.value ?? '00';
  const second = parts.find((part) => part.type === 'second')?.value ?? '00';
  const millisecond = String(date.getMilliseconds()).padStart(3, '0');
  return `${year}-${month}-${day} ${hour}:${minute}:${second}.${millisecond}`;
}

function log(message) {
  process.stdout.write(`[watchdog] ${formatTimestamp()} ${message}\n`);
}

async function fetchJson(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!response.ok) {
      throw new Error(`${pathname} returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function restartTarget(reason) {
  const now = Date.now();
  if (now - lastRestartAt < RESTART_COOLDOWN_MS) {
    log(`restart skipped during cooldown: ${reason}`);
    return;
  }

  lastRestartAt = now;
  log(`restarting ${TARGET_PROCESS}: ${reason}`);
  const quotedPm2 = /\s/.test(PM2_CMD) ? `"${PM2_CMD}"` : PM2_CMD;
  await execAsync(`${quotedPm2} restart ${TARGET_PROCESS} --update-env`, {
    windowsHide: true,
  });
}

function shouldEnforceFailures() {
  return Date.now() - startedAt >= STARTUP_GRACE_MS;
}

async function runHealthChecks() {
  const [scheduler, simScheduler, health] = await Promise.all([
    fetchJson(SCHEDULER_PATH),
    fetchJson(SIM_SCHEDULER_PATH),
    fetchJson(HEALTH_PATH),
  ]);

  const now = Date.now();
  const shouldRunDataProbe = now - lastDataProbeAt >= DATA_PROBE_INTERVAL_MS;
  let dataProbeFailed = false;
  let hardDataFailure = false;

  if (shouldRunDataProbe) {
    lastDataProbeAt = now;

    try {
      const [funding, orderbook] = await Promise.all([
        fetchJson(FUNDING_PROBE_PATH),
        fetchJson(ORDERBOOK_PROBE_PATH),
      ]);

      if (!Number.isFinite(orderbook?.fillPrice)) {
        throw new Error('orderbook fillPrice unavailable');
      }

      const fundingCache = funding?.data?.cacheState?.binance;
      if (!fundingCache) {
        throw new Error('funding cache state unavailable');
      }
    } catch (error) {
      dataProbeFailed = true;
      hardDataFailure = true;
      dataFailCount += 1;
      log(`data probe failed (${dataFailCount}/${DATA_FAIL_THRESHOLD}): ${(error && error.message) || error}`);
    }
  }

  const fundingHealth = health?.data?.funding?.binance;
  const fundingStalled = fundingHealth?.source === 'stale-cache'
    && Number.isFinite(fundingHealth?.ageMs)
    && fundingHealth.ageMs >= FUNDING_STALL_THRESHOLD_MS;

  if (!hardDataFailure && shouldRunDataProbe) {
    if (fundingStalled) {
      dataFailCount += 1;
      log(`funding stalled (${dataFailCount}/${DATA_FAIL_THRESHOLD}): age=${fundingHealth.ageMs}ms`);
    } else {
      dataFailCount = 0;
      if (dataProbeFailed) {
        dataProbeFailed = false;
      }
    }
  }

  return { scheduler, simScheduler, health };
}

async function cycle() {
  try {
    const { scheduler, simScheduler, health } = await runHealthChecks();
    appFailCount = 0;

    const realActive = scheduler?.active === true;
    const simActive = simScheduler?.active === true;
    const targetActive = isExpectedModeActive(realActive, simActive);
    const fundingHealth = health?.data?.funding?.binance;
    const orderbookHealth = health?.data?.orderbook;
    log(
      `ok realActive=${realActive ? 'yes' : 'no'} `
      + `simActive=${simActive ? 'yes' : 'no'} `
      + `targetActive(${EXPECTED_MODE})=${targetActive ? 'yes' : 'no'} `
      + `funding=${fundingHealth?.source || 'none'} `
      + `orderbookFresh=${orderbookHealth?.freshEntries ?? 0}`,
    );

    if (shouldEnforceFailures() && dataFailCount >= DATA_FAIL_THRESHOLD) {
      dataFailCount = 0;
      await restartTarget('market-data probes failed repeatedly');
    }
  } catch (error) {
    appFailCount += 1;
    log(`app probe failed (${appFailCount}/${APP_FAIL_THRESHOLD}): ${(error && error.message) || error}`);

    if (shouldEnforceFailures() && appFailCount >= APP_FAIL_THRESHOLD) {
      appFailCount = 0;
      dataFailCount = 0;
      await restartTarget('app endpoints failed repeatedly');
    }
  }
}

log(`starting watchdog for ${TARGET_PROCESS} at ${BASE_URL} (expectedMode=${EXPECTED_MODE})`);
void cycle();
setInterval(() => {
  void cycle();
}, CHECK_INTERVAL_MS);

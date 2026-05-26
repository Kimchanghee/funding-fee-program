const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const BASE_URL = process.env.WATCHDOG_BASE_URL || 'http://127.0.0.1:3000';
const TARGET_PROCESS = process.env.WATCHDOG_TARGET_PROCESS || 'funding-fee-program';
const INTERNAL_API_TOKEN = process.env.WATCHDOG_INTERNAL_API_TOKEN
  || process.env.INTERNAL_API_TOKEN
  || process.env.SITE_PASSWORD
  || '';
const CHECK_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 20000);
const HTTP_TIMEOUT_MS = Number(process.env.WATCHDOG_HTTP_TIMEOUT_MS || 10000);
const APP_FAIL_THRESHOLD = Number(process.env.WATCHDOG_APP_FAIL_THRESHOLD || 3);
const DATA_FAIL_THRESHOLD = Number(process.env.WATCHDOG_DATA_FAIL_THRESHOLD || 3);
const STARTUP_GRACE_MS = Number(process.env.WATCHDOG_STARTUP_GRACE_MS || 90000);
const RESTART_COOLDOWN_MS = Number(process.env.WATCHDOG_RESTART_COOLDOWN_MS || 120000);
const DATA_PROBE_INTERVAL_MS = Number(process.env.WATCHDOG_DATA_PROBE_INTERVAL_MS || 20000);
const FUNDING_STALL_THRESHOLD_MS = Number(process.env.WATCHDOG_FUNDING_STALL_THRESHOLD_MS || 60000);
const AUTO_START_SIM = String(process.env.WATCHDOG_AUTO_START_SIM || 'false').toLowerCase() === 'true';
const SIM_START_COOLDOWN_MS = Number(process.env.WATCHDOG_SIM_START_COOLDOWN_MS || 60000);

const SIM_SCHEDULER_PATH = '/api/sim-scheduler';
const HEALTH_PATH = '/api/market-data-health';
const FUNDING_PROBE_PATH = '/api/funding-rates?exchanges=binance';
const ORDERBOOK_PROBE_PATH = '/api/exchanges/binance/orderbook?symbol=BTC%2FUSDT%3AUSDT&side=buy&notional=1000';

const PM2_CMD = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';

let appFailCount = 0;
let dataFailCount = 0;
let lastDataProbeAt = 0;
let lastRestartAt = 0;
let lastSimStartAt = 0;
const startedAt = Date.now();

const EXPECTED_MODE = 'sim';

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

function buildHeaders(extra = {}) {
  return {
    ...extra,
    ...(INTERNAL_API_TOKEN ? { 'x-internal-api-token': INTERNAL_API_TOKEN } : {}),
  };
}

async function fetchJson(pathname) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      signal: controller.signal,
      cache: 'no-store',
      headers: buildHeaders(),
    });

    if (!response.ok) {
      throw new Error(`${pathname} returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(pathname, body) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const response = await fetch(`${BASE_URL}${pathname}`, {
      method: 'POST',
      signal: controller.signal,
      cache: 'no-store',
      headers: buildHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify(body),
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

function shouldAutoStartSim(simActive) {
  if (!AUTO_START_SIM || simActive) return false;
  return true;
}

async function startSimScheduler(simScheduler) {
  const now = Date.now();
  if (now - lastSimStartAt < SIM_START_COOLDOWN_MS) {
    log('sim auto-start skipped during cooldown');
    return;
  }

  const config = simScheduler?.config;
  if (!config || !Array.isArray(config.enabledExchanges) || config.enabledExchanges.length === 0) {
    log('sim auto-start skipped: missing enabled exchange config');
    return;
  }

  lastSimStartAt = now;

  try {
    const result = await postJson(SIM_SCHEDULER_PATH, { action: 'start', config });
    const status = result?.status;
    const scheduledCount = Array.isArray(status?.scheduledEntries) ? status.scheduledEntries.length : 0;
    log(`sim auto-started active=${status?.active === true ? 'yes' : 'no'} scheduled=${scheduledCount}`);
  } catch (error) {
    log(`sim auto-start failed: ${(error && error.message) || error}`);
  }
}

async function runHealthChecks() {
  const [simScheduler, health] = await Promise.all([
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

  return { simScheduler, health };
}

async function cycle() {
  try {
    const { simScheduler, health } = await runHealthChecks();
    appFailCount = 0;

    const simActive = simScheduler?.active === true;
    const targetActive = simActive;
    const fundingHealth = health?.data?.funding?.binance;
    const orderbookHealth = health?.data?.orderbook;
    log(
      `ok simActive=${simActive ? 'yes' : 'no'} `
      + `targetActive(${EXPECTED_MODE})=${targetActive ? 'yes' : 'no'} `
      + `funding=${fundingHealth?.source || 'none'} `
      + `orderbookFresh=${orderbookHealth?.freshEntries ?? 0}`,
    );

    if (shouldAutoStartSim(simActive)) {
      await startSimScheduler(simScheduler);
    }

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

log(`starting watchdog for ${TARGET_PROCESS} at ${BASE_URL} (expectedMode=${EXPECTED_MODE}, autoStartSim=${AUTO_START_SIM ? 'yes' : 'no'})`);
void cycle();
setInterval(() => {
  void cycle();
}, CHECK_INTERVAL_MS);

# funding-fee-program

Funding-fee hedge bot dashboard and scheduler. The checked-in local setup is SIM-first: it starts the server and turns on the simulation scheduler with the current aggressive hedge profile. It does not start real trading.

## Quick start on a new machine

```bash
git clone https://github.com/Kimchanghee/funding-fee-program.git
cd funding-fee-program

cp .env.local.example .env.local
npm ci
npm run build

./start-local.command
```

Then open:

```text
http://127.0.0.1:3000
```

Default password:

```text
9788
```

## What start-local.command does

- Loads `.env.local`.
- Binds the app to `127.0.0.1:3000`.
- Stops any previous process on the same port.
- Starts the production standalone server.
- Starts or updates the SIM scheduler.
- Leaves the REAL scheduler off.

The SIM scheduler is started with:

```text
investmentUSDT=250
leverage=17
minSpreadPercent=0.03
enabledExchanges=binance,bybit,okx,bitget,gate,bingx
useDynamicNotional=true
dynamicNotionalCap=300000
useIocLimitOnly=true
useStrictHedge=true
```

## Check status

```bash
./check-status.command
```

This shows server health, SIM scheduler status, scheduled entries, active SIM positions, balances, and recent milestone events.

## PM2 background mode

```bash
npm install -g pm2
npm run pm2:start
npm run pm2:save
```

PM2 starts both the app and the watchdog. The watchdog is configured for SIM mode and can auto-start the SIM scheduler if it stops.

Stop PM2:

```bash
npm run pm2:stop
```

## Real trading

Real trading is intentionally not auto-started by these scripts. Before using real mode, configure exchange API keys in the app UI, verify balances/permissions per exchange, run SIM long enough to inspect diagnostics, and then enable real scheduling manually from the app.

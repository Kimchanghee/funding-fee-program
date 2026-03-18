# Funding Fee Program

## Tech Stack
- Next.js 15.1.6 (App Router, Turbopack)
- React 19, TypeScript 5
- Tailwind CSS 4
- Zustand (state management)
- CCXT (crypto exchange API)

## Development

```bash
npm install    # Install dependencies
npm run dev    # Start dev server → http://localhost:3000
npm run build  # Production build (standalone output)
npm start      # Run production server
```

## AWS Deployment

`next.config.ts`에 `output: "standalone"` 설정 적용됨.

```bash
npm run build
# .next/standalone/ 폴더를 EC2/ECS에 배포
node .next/standalone/server.js
```

## Project Structure
- `app/` — Next.js App Router pages & API routes
- `app/api/` — Server-side API endpoints (funding-rates, exchanges, trades, logs, strategy)
- `components/` — React UI components (dashboard)
- `lib/` — Shared utilities (exchanges, types, opportunities, keyStore)
- `store/` — Zustand state stores

## Key Commands
- `npm run dev` — 개발 서버 (Turbopack, HMR)
- `npm run build` — 프로덕션 빌드
- `npm run lint` — ESLint 검사

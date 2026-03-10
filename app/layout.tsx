import type { Metadata } from 'next';
import { Noto_Sans_KR } from 'next/font/google';
import './globals.css';

const notoSansKR = Noto_Sans_KR({
  subsets: ['latin'],
  weight: ['400', '600', '700', '900'],
  variable: '--font-noto',
  display: 'swap',
});

export const metadata: Metadata = {
  title: '펀딩피 헷징 — 멀티 거래소 아비트라지',
  description: 'OKX, BITGET, BINANCE, BYBIT, GATE 5개 거래소 선물 펀딩피 헷징 자동화 프로그램',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className={notoSansKR.variable}>
      <body style={{ background: 'var(--bg-primary)', color: 'var(--color-text)', minHeight: '100vh' }}>
        {children}
      </body>
    </html>
  );
}

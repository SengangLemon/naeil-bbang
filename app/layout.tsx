import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "내일의 빵 · 생산계획과 모델 비교",
  description: "매일 판매·재고를 기록하고 내일 생산량과 모델별 예측오차를 비교하세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}

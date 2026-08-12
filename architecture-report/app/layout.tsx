import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WASM-OJ Architecture v2｜Chief Architect Implementation Report",
  description:
    "WASM-OJ Architecture v2 的 P0／P1 修復證據、資料流、R2 生命週期、效能差異與正式切換狀態。",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}

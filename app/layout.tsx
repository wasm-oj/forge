import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { resolveRequestOrigin } from "@/src/core/request-origin";
import { AppShell } from "@/src/components/app-shell";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const metadataBase = resolveRequestOrigin({
    forwardedHost: requestHeaders.get("x-forwarded-host"),
    forwardedProtocol: requestHeaders.get("x-forwarded-proto"),
    host: requestHeaders.get("host"),
  });
  const description = "Learn programming with official practice problems, browser-local runs, contests, and verified submissions.";
  return {
    metadataBase,
    title: "WASM OJ Forge",
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "WASM OJ Forge",
      description: "Official practice, browser-local runs, contests, and verified submissions.",
      type: "website",
      images: [{ url: new URL("/og.png", metadataBase).toString(), width: 1200, height: 630, alt: "WASM OJ Forge — deterministic browser-local compilation and judging" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "WASM OJ Forge",
      description: "Official practice, browser-local runs, contests, and verified submissions.",
      images: [new URL("/og.png", metadataBase).toString()],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${geistSans.variable} ${geistMono.variable}`}><AppShell>{children}</AppShell></body>
    </html>
  );
}

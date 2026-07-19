import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { resolveRequestOrigin } from "@/src/core/request-origin";
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
  const description = "A private, fully in-browser online judge with 45 original challenges and seven Wasmer-powered languages.";
  return {
    metadataBase,
    title: "WASM OJ Forge",
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "WASM OJ Forge",
      description: "45 challenges. Seven languages. Zero code uploads.",
      type: "website",
      images: [{ url: new URL("/og.png", metadataBase).toString(), width: 1200, height: 630, alt: "WASM OJ Forge — deterministic browser-local compilation and judging" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "WASM OJ Forge",
      description: "45 challenges. Seven languages. Zero code uploads.",
      images: [new URL("/og.png", metadataBase).toString()],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}

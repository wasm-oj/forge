import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3000";
  const protocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0] ?? (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const description = "A private, fully in-browser online judge with 20 original challenges and six Wasmer-powered languages.";
  return {
    metadataBase,
    title: "LocalWASI Judge",
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "LocalWASI Judge",
      description: "20 challenges. Six languages. Zero code uploads.",
      type: "website",
      images: [{ url: new URL("/og.png", metadataBase).toString(), width: 1726, height: 911, alt: "LocalWASI Judge — 20 browser-local programming challenges" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "LocalWASI Judge",
      description: "20 challenges. Six languages. Zero code uploads.",
      images: [new URL("/og.png", metadataBase).toString()],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}

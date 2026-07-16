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
  const description = "A private, browser-local multi-language WASI and WASIX compiler powered by Wasmer.";
  return {
    metadataBase,
    title: "LocalWASI Studio",
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "LocalWASI Studio",
      description: "Compile locally. Run anywhere.",
      type: "website",
      images: [{ url: new URL("/og.png", metadataBase).toString(), width: 1731, height: 909, alt: "LocalWASI Studio — compile locally, run anywhere" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "LocalWASI Studio",
      description: "Compile locally. Run anywhere.",
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

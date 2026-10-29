import type { Metadata } from "next";
import type { ReactNode } from "react";
import Script from "next/script";
import { Geist } from "next/font/google";
import { cn } from "@/lib/utils";

import { Providers } from "../components/providers";

import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME === "1" ? "AI Design Hub" : "Loomic",
  description: "AI-powered creative workspace",
  icons: {
    icon: process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME === "1" ? "/ai-design-hub-icon.png" : "/favicon.svg",
    apple: "/apple-touch-icon.png",
  },
  openGraph: {
    title: "Loomic",
    description: "AI-powered creative workspace",
    images: [{ url: "/og-image.png", width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Loomic",
    description: "AI-powered creative workspace",
    images: ["/og-image.png"],
  },
  ...(process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME === "1" ? { referrer: "no-referrer" as const } : {}),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang={process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME === "1" ? "zh-CN" : "en"} className={cn(geist.variable, "scroll-smooth")} suppressHydrationWarning>
      <head>
        {process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME === "1" && <script dangerouslySetInnerHTML={{ __html: "window.EXCALIDRAW_ASSET_PATH='/excalidraw-assets/';" }} />}
      </head>
      <body className="min-h-screen bg-background font-sans antialiased">
        <Providers>{children}</Providers>
        {process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME !== "1" && <Script
          src="https://app.lemonsqueezy.com/js/lemon.js"
          strategy="lazyOnload"
        />}
      </body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/shared/toast-provider";
import { EnvironmentBanner } from "@/components/shared/environment-banner";
import { Analytics } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TWV CRM",
  // Internal tool — no public description exposed
  robots: {
    index: false,
    follow: false,
    googleBot: { index: false, follow: false },
  },
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "TWV CRM",
  },
};

export const viewport: Viewport = {
  themeColor: "#015E65",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
      </head>
      <body className={`${inter.variable} antialiased`}>
        <EnvironmentBanner />
        {children}
        <ToastProvider />
        <Analytics />
        <SpeedInsights />
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TWV CRM",
  description: "Coworking Space CRM for The WorkVilla",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

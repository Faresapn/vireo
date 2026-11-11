import "./globals.css";
import type { Metadata } from "next";
import { Space_Grotesk, Inter, Geist_Mono } from "next/font/google";

const display = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-display",
});
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
});
const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Vireo Studio",
  description: "Autonomous viral video studio — per-persona motion transfer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-void text-ink antialiased">
        {children}
      </body>
    </html>
  );
}

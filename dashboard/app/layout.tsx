import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Higgsfield Studio",
  description: "Auto video generation pipeline — per-persona motion transfer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body className="min-h-screen bg-void text-ink font-sans antialiased">
        {children}
      </body>
    </html>
  );
}

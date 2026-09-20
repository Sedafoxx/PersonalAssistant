import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Nova",
  description: "Nova — your personal assistant",
  manifest: "/manifest.json",
};

export const viewport: Viewport = {
  themeColor: "#0f0f0f",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      {/* h-dvh (dynamic viewport height) instead of h-screen so mobile browsers
          with a visible/retracting URL bar get the real visible height. */}
      <body className="h-dvh overflow-hidden">{children}</body>
    </html>
  );
}

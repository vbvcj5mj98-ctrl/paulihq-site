import type { Metadata } from "next";
import "./globals.css";
import AssistantBubble from "./AssistantBubble";

export const metadata: Metadata = {
  title: "Pauli HQ",
  description: "The Pauli family home for what comes next.",
  icons: {
    icon: [{ url: "/app-icon-192.png?v=2", sizes: "192x192", type: "image/png" }],
    shortcut: [{ url: "/app-icon-192.png?v=2", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  manifest: "/site.webmanifest",
  appleWebApp: {
    capable: true,
    title: "Pauli HQ",
    statusBarStyle: "black-translucent",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}<AssistantBubble /></body>
    </html>
  );
}

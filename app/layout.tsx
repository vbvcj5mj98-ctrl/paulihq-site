import type { Metadata } from "next";
import "./globals.css";
import AssistantBubble from "./AssistantBubble";

export const metadata: Metadata = {
  title: "Pauli HQ",
  description: "The Pauli family home for what comes next.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}<AssistantBubble /></body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Carson Pauli",
  description: "A place for what comes next.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

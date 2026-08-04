import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Life Command",
  description: "Personal AI finance + life platform — local",
  manifest: "/manifest.webmanifest",
};

export const viewport = {
  themeColor: "#0e1219",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  );
}

import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "NewPipe Web • Extractor Explorer",
  description: "Explore NewPipeExtractor search, channels, playlists, and video metadata through a Vercel-ready REST API gateway.",
  applicationName: "NewPipe Web",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#080c18" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="id"><body>{children}</body></html>;
}

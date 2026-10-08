import type { ReactNode } from 'react';
import type { Metadata, Viewport } from 'next';
import { Inter, Fraunces, JetBrains_Mono } from 'next/font/google';
import './globals.css';

// The desk's type (06a §16, the UI kit): Inter for text, JetBrains Mono for the micro-labels,
// Fraunces for the italic accent. next/font downloads them at build time and serves them from
// this app, so no page asks Google for anything.
const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const fraunces = Fraunces({ subsets: ['latin'], variable: '--font-fraunces', display: 'swap', style: ['italic', 'normal'] });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'Clinic Pharmacy · Engageo',
  description: 'Dispensary and stock for clinics',
  icons: { icon: '/engageo-mark.svg' },
  // A light-only design: ask browser dark modes and dark-mode extensions to leave it alone.
  other: { 'darkreader-lock': '' },
};

export const viewport: Viewport = { colorScheme: 'light', themeColor: '#F5F3EE' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${fraunces.variable} ${mono.variable} min-h-screen bg-canvas font-sans text-body text-ink`}>{children}</body>
    </html>
  );
}

import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Clinic Pharmacy',
  description: 'Dispensary and stock for clinics',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}

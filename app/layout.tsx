import type { ReactNode } from 'react';

export const metadata = {
  title: 'Clinic Pharmacy',
  description: 'Dispensary and stock for clinics',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

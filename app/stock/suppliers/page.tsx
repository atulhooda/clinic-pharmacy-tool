import { redirect } from 'next/navigation';

/** Suppliers live under Receive now (one place for deliveries and who they come from). */
export default function Page() {
  redirect('/stock/receive?tab=suppliers');
}

import { redirect } from 'next/navigation';

export default function StockHome() {
  redirect('/stock/items');
}

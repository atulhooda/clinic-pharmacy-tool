'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ComboItem } from '@/components/ui/Combobox';
import { api } from '@/components/settings/client';
import { unitWord } from './format';

/** The client's view of the catalogue, shared by the stock screens. */
export type Unit = { id: string; name: string; baseUnitsPerUnit: number; isBase: boolean; dispensable: boolean; purchasable: boolean; active: boolean };
export type ItemOpt = { id: string; displayName: string; category: string; baseUnit: string; active: boolean; stock?: { onHandBase: number } };
export type SupplierOpt = { id: string; name: string; licenceStatus: string; active: boolean; gstin: string | null };
export type PremisesOpt = { id: string; name: string; settings: unknown | null };

export const CATEGORY_LABEL: Record<string, string> = { MEDICINE: 'Medicine', RETAIL_PRODUCT: 'Retail', INJECTABLE: 'Injectable', CONSUMABLE: 'Consumable' };

/** Every item of the organisation (the dropdowns list them all, searchable). */
export function useItems() {
  const [items, setItems] = useState<ItemOpt[]>([]);
  const reload = useCallback(async () => {
    const out: ItemOpt[] = [];
    let cursor: string | null = null;
    do {
      const r: { ok: boolean; body: { items: ItemOpt[]; nextCursor: string | null } } =
        await api(`/api/dispensary/items?limit=200${cursor ? `&cursor=${cursor}` : ''}`);
      if (!r.ok) break;
      out.push(...r.body.items);
      cursor = r.body.nextCursor;
    } while (cursor);
    setItems(out);
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  return { items, reload };
}

export function useSuppliers() {
  const [suppliers, setSuppliers] = useState<SupplierOpt[]>([]);
  useEffect(() => { void api<{ items: SupplierOpt[] }>('/api/dispensary/suppliers').then((r) => r.ok && setSuppliers(r.body.items)); }, []);
  return suppliers;
}

export function usePremises() {
  const [premises, setPremises] = useState<PremisesOpt[]>([]);
  useEffect(() => { void api<{ items: PremisesOpt[] }>('/api/dispensary/premises').then((r) => r.ok && setPremises(r.body.items)); }, []);
  return premises;
}

/** An item as a dropdown entry: its name, with its kind and balance underneath. */
export const itemOption = (i: ItemOpt): ComboItem => ({
  value: i.id, label: i.displayName, disabled: !i.active,
  sub: `${CATEGORY_LABEL[i.category] ?? i.category} · ${unitWord(i.stock?.onHandBase ?? 0, i.baseUnit)} in stock`,
});

/** Paise as plain rupees for an input ("4500" → "45.00"), by string slicing. */
export function rupeesText(p: number | null | undefined): string {
  if (p === null || p === undefined) return '';
  const d = String(Math.abs(p)).padStart(3, '0');
  return `${p < 0 ? '-' : ''}${d.slice(0, -2)}.${d.slice(-2)}`;
}

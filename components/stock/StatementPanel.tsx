'use client';

import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import DataList from '@/components/ui/DataList';
import FilterPills from '@/components/ui/FilterPills';
import { TextField, SelectField } from '@/components/ui/Field';
import { IconPrint } from '@/components/ui/icons';
import { en } from '@/lib/i18n/en';
import { api } from '@/components/settings/client';
import { packs, type PackUnit } from './format';
import { usePremises } from './catalogue';

const t = en.statement;
type Row = { itemId: string; name: string; category: string; baseUnit: string; units: PackUnit[]; opening: number; received: number; issued: number;
  returned: number; other: number; balance: number; quarantined: number };
type Preset = 'MONTH' | 'LAST' | 'TODAY' | 'CUSTOM';

const istToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
function presetRange(p: Preset): { from: string; to: string } {
  const today = istToday();
  if (p === 'TODAY') return { from: today, to: today };
  const [y, m] = today.split('-').map(Number);
  if (p === 'MONTH') return { from: `${today.slice(0, 7)}-01`, to: today };
  const ly = m === 1 ? y - 1 : y;
  const lm = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(ly, lm, 0)).getUTCDate();
  const mm = String(lm).padStart(2, '0');
  return { from: `${ly}-${mm}-01`, to: `${ly}-${mm}-${String(last).padStart(2, '0')}` };
}

/** E-45 (D-47): opening + received − issued + returned + other = balance, per item, for a period. */
export function StatementPanel() {
  const premises = usePremises();
  const [preset, setPreset] = useState<Preset>('MONTH');
  const [range, setRange] = useState(presetRange('MONTH'));
  const [premisesId, setPremisesId] = useState('');
  const [all, setAll] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [error, setError] = useState<string | null>(null);
  const qs = `from=${range.from}&to=${range.to}${premisesId ? `&premisesId=${premisesId}` : ''}${all ? '&all=true' : ''}`;
  useEffect(() => {
    void api<{ rows: Row[] }>(`/api/dispensary/reports/stock-statement?${qs}`).then((r) => {
      if (r.ok) { setRows(r.body.rows); setError(null); } else setError(r.body.error ?? en.settings.failed);
    });
  }, [qs]);
  const choose = (p: Preset) => { setPreset(p); if (p !== 'CUSTOM') setRange(presetRange(p)); };
  const num = (n: number) => <span className="tnum">{n}</span>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterPills value={preset} onChange={choose} options={[
          { key: 'MONTH', label: t.thisMonth }, { key: 'LAST', label: t.lastMonth }, { key: 'TODAY', label: t.today }, { key: 'CUSTOM', label: t.custom },
        ]} />
        {preset === 'CUSTOM' && (
          <>
            <TextField label={t.from} type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} />
            <TextField label={t.to} type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </>
        )}
        {premises.length > 1 && (
          <SelectField label={en.receive.premises} value={premisesId} onChange={(e) => setPremisesId(e.target.value)}>
            <option value="">{t.allPremises}</option>
            {premises.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </SelectField>
        )}
        <div className="flex gap-2 md:ml-auto">
          <Button onClick={() => window.location.assign(`/api/dispensary/reports/stock-statement?${qs}&format=csv`)}>{t.csv}</Button>
          <Button onClick={() => window.open(`/api/dispensary/reports/stock-statement?${qs}&format=print`, '_blank', 'noopener')}>
            <IconPrint className="h-4 w-4" /> {t.print}
          </Button>
        </div>
      </div>
      <label className="flex items-center gap-2 text-small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t.showAll}</label>
      {error && <p role="alert" className="text-small text-bad">{error}</p>}
      <div className="card overflow-hidden">
        <DataList rows={rows} rowKey={(r) => r.itemId} empty={t.empty} columns={[
          { key: 'item', header: t.item, primary: true, cell: (r) => (
            <span><span className="block font-semibold text-ink">{r.name}</span><span className="block text-micro text-muted">{r.baseUnit.toLowerCase()}</span></span>) },
          { key: 'opening', header: t.opening, align: 'right', cell: (r) => num(r.opening) },
          { key: 'received', header: t.received, align: 'right', cell: (r) => num(r.received) },
          { key: 'issued', header: t.issued, align: 'right', cell: (r) => num(r.issued) },
          { key: 'returned', header: t.returned, align: 'right', phoneHidden: true, cell: (r) => num(r.returned) },
          { key: 'other', header: t.other, align: 'right', phoneHidden: true, cell: (r) => num(r.other) },
          { key: 'balance', header: t.balance, align: 'right', cell: (r) => (
            <span className="block text-right">
              <span className="block font-semibold tnum text-ink">{r.balance}</span>
              <span className="block text-micro text-muted">{packs(r.balance, r.baseUnit, r.units)}{r.quarantined ? ` · ${r.quarantined} ${t.quarantined}` : ''}</span>
            </span>) },
        ]} />
      </div>
    </div>
  );
}

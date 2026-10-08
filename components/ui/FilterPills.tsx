'use client';

// The desk's filter pills: "All 200 · Booked 93 · …". The active one is ink; the counts are muted.
export default function FilterPills<K extends string>({ options, value, onChange }: {
  options: { key: K; label: string; count?: number }[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2" role="tablist">
      {options.map((o) => {
        const on = o.key === value;
        return (
          <button key={o.key} type="button" role="tab" aria-selected={on} onClick={() => onChange(o.key)}
            className={`inline-flex min-h-[40px] items-center gap-1.5 rounded-full border px-4 text-small font-semibold transition-colors ${
              on ? 'border-ink bg-ink text-white' : 'border-hairline-firm bg-surface text-ink-soft hover:border-ink'
            }`}>
            {o.label}
            {o.count !== undefined && <span className={`tnum ${on ? 'text-white/70' : 'text-faint'}`}>{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}

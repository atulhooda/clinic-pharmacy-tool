'use client';

import { IconSearch } from './icons';

// The desk's search box: a rounded field with the magnifier inside.
export default function SearchField({ value, onChange, placeholder, className = '' }: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  className?: string;
}) {
  return (
    <label className={`relative block ${className}`}>
      <span className="sr-only">{placeholder}</span>
      <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted" />
      <input type="search" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)}
        className="field-input !pl-11" />
    </label>
  );
}

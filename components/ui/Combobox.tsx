"use client";

import { Combobox as B } from "@base-ui/react/combobox";

// A searchable picker on Base UI's Combobox (keyboard, typeahead, listbox
// semantics — the one primitive a small team should not hand-roll). Visuals on
// the tokens. Free text is reported through onInputChange so a new patient
// name can be typed where the list has no match.
export interface ComboItem {
  value: string;
  label: string;
  sub?: string;
  disabled?: boolean;
  lang?: string;
}

export default function Combobox({
  items,
  value,
  onChange,
  onInputChange,
  placeholder,
  emptyText,
  id,
  describedBy,
  autoFocus,
}: {
  items: ComboItem[];
  value: string | null;
  onChange: (value: string | null, item: ComboItem | null) => void;
  onInputChange?: (text: string) => void;
  placeholder?: string;
  emptyText: string;
  id?: string;
  describedBy?: string;
  autoFocus?: boolean;
}) {
  const selected = items.find((i) => i.value === value) ?? null;
  return (
    <B.Root<ComboItem>
      items={items}
      value={selected}
      onValueChange={(v) => onChange(v ? v.value : null, v)}
      onInputValueChange={(text) => onInputChange?.(text)}
      itemToStringLabel={(i) => i.label}
      itemToStringValue={(i) => i.value}
      isItemEqualToValue={(a, b) => a.value === b.value}
      autoHighlight
    >
      <div className="relative">
        <B.Input id={id} aria-describedby={describedBy} placeholder={placeholder} autoFocus={autoFocus} className="field-input pr-10" />
        <B.Trigger className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted" aria-label="Open">
          <B.Icon>▾</B.Icon>
        </B.Trigger>
      </div>
      <B.Portal>
        <B.Positioner sideOffset={4} className="z-toast">
          <B.Popup className="max-h-[min(320px,50vh)] w-[var(--anchor-width)] overflow-y-auto rounded-xl border border-hairline bg-surface p-1 shadow-card outline-none">
            <B.Empty className="px-3 py-2 text-small text-muted">{emptyText}</B.Empty>
            <B.List>
              {(item: ComboItem) => (
                <B.Item
                  key={item.value}
                  value={item}
                  disabled={item.disabled}
                  className="flex cursor-default items-center justify-between gap-3 rounded-lg px-3 py-2 text-small text-ink data-[highlighted]:bg-brand-tint data-[selected]:font-semibold data-[disabled]:opacity-50"
                >
                  <span lang={item.lang}>{item.label}</span>
                  {item.sub && <span className="shrink-0 text-micro text-muted">{item.sub}</span>}
                </B.Item>
              )}
            </B.List>
          </B.Popup>
        </B.Positioner>
      </B.Portal>
    </B.Root>
  );
}

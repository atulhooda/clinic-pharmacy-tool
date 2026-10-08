"use client";

import { useEffect, useId, useRef, useState } from "react";
import IconButton from "./IconButton";
import { IconDots } from "./icons";

// Row actions. Hand-rolled (the judges cut Base UI to dialog + combobox), but
// with the semantics a menu owes: a button with aria-haspopup, role=menu,
// arrow-key movement, Escape and outside-click to close, focus returned.
export interface MenuAction {
  key: string;
  label: string;
  onSelect: () => void;
  tone?: "default" | "danger";
  disabled?: boolean;
  lang?: string;
}

export default function Menu({ actions, label, align = "right", trigger = "dots" }: { actions: MenuAction[]; label: string; align?: "left" | "right"; trigger?: "dots" | "button" }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const items = () => Array.from(list.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? []);
    items()[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      const els = items();
      const i = els.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btn.current?.focus();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        els[(i + 1) % els.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        els[(i - 1 + els.length) % els.length]?.focus();
      } else if (e.key === "Tab") {
        setOpen(false);
      }
    };
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open]);

  return (
    <div className="relative">
      {trigger === "button" ? (
        <button
          ref={btn}
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((o) => !o)}
          className="btn-ghost whitespace-nowrap"
        >
          {label} <span aria-hidden>▾</span>
        </button>
      ) : (
        <IconButton
          ref={btn}
          label={label}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? id : undefined}
          onClick={() => setOpen((o) => !o)}
        >
          <IconDots />
        </IconButton>
      )}
      {open && (
        <div
          ref={list}
          id={id}
          role="menu"
          aria-label={label}
          className={`absolute z-toast mt-1 min-w-[200px] rounded-xl border border-hairline bg-surface p-1 shadow-card animate-fade-in ${align === "right" ? "right-0" : "left-0"}`}
        >
          {actions.map((a) => (
            <button
              key={a.key}
              role="menuitem"
              type="button"
              disabled={a.disabled}
              lang={a.lang}
              onClick={() => {
                setOpen(false);
                btn.current?.focus();
                a.onSelect();
              }}
              className={`block w-full min-h-tap rounded-lg px-3 py-2 text-left text-small transition-colors disabled:opacity-50 ${
                a.tone === "danger" ? "text-bad hover:bg-bad-wash" : "text-ink hover:bg-hairline/60"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

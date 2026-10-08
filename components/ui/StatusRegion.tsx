"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Button from "./Button";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";

// THE PERMANENTLY MOUNTED STATUS REGION. One aria-live region in the shell;
// every screen pushes into it. A toast with an undo stays until its undo
// window closes (default 15 min, ticking), a plain notice for 6s, an error
// until dismissed. Never more than three on screen; the oldest yields.
export interface Notice {
  id: string;
  message: string;
  tone?: "ok" | "info" | "bad";
  undo?: { label?: string; until?: number; run: () => Promise<void> | void };
  /** A place to go (a callback alert's Open). */
  action?: { label: string; href: string };
  ttlMs?: number;
}

type Ctx = {
  notify: (n: Omit<Notice, "id"> & { id?: string }) => string;
  dismiss: (id: string) => void;
};
const C = createContext<Ctx>({ notify: () => "", dismiss: () => {} });

export function useStatus() {
  return useContext(C);
}

export function StatusProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    setItems((l) => l.filter((n) => n.id !== id));
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
  }, []);

  const notify = useCallback(
    (n: Omit<Notice, "id"> & { id?: string }) => {
      const id = n.id ?? `n${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      const notice: Notice = { ...n, id };
      setItems((l) => [...l.filter((x) => x.id !== id), notice].slice(-3));
      const ttl = n.ttlMs ?? (n.undo ? Math.max(1000, (n.undo.until ?? Date.now() + 15 * 60_000) - Date.now()) : n.tone === "bad" ? 0 : 6000);
      if (ttl > 0) {
        const prev = timers.current.get(id);
        if (prev) clearTimeout(prev);
        timers.current.set(id, setTimeout(() => dismiss(id), ttl));
      }
      return id;
    },
    [dismiss]
  );

  const value = useMemo(() => ({ notify, dismiss }), [notify, dismiss]);
  return (
    <C.Provider value={value}>
      {children}
      <Region items={items} dismiss={dismiss} />
    </C.Provider>
  );
}

function Region({ items, dismiss }: { items: Notice[]; dismiss: (id: string) => void }) {
  const { t } = useT();
  const router = useRouter();
  const [, tick] = useState(0);
  useEffect(() => {
    if (!items.some((i) => i.undo)) return;
    const h = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(h);
  }, [items]);
  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed inset-x-0 bottom-[calc(theme(spacing.tabs)+12px)] z-toast flex flex-col items-center gap-2 px-4 md:bottom-5"
    >
      {items.map((n) => {
        const minsLeft = n.undo ? Math.max(0, Math.ceil(((n.undo.until ?? Date.now()) - Date.now()) / 60_000)) : 0;
        return (
          <div
            key={n.id}
            role={n.tone === "bad" ? "alert" : "status"}
            className={`pointer-events-auto flex w-full max-w-[560px] items-center gap-3 rounded-xl2 px-4 py-2.5 text-small shadow-card ${
              n.tone === "bad" ? "border border-bad/30 bg-bad-wash text-bad-ink" : "bg-ink text-canvas"
            }`}
          >
            <span className="min-w-0 flex-1">{n.message}</span>
            {n.action && (
              <Button
                size="sm"
                variant="ghost"
                className="!bg-canvas !text-ink"
                onClick={() => {
                  dismiss(n.id);
                  router.push(n.action!.href);
                }}
              >
                {n.action.label}
              </Button>
            )}
            {n.undo && (
              <Button
                size="sm"
                variant="ghost"
                className="!bg-canvas !text-ink"
                onClick={async () => {
                  dismiss(n.id);
                  await n.undo!.run();
                }}
              >
                {n.undo.label ?? (n.undo.until ? t("event.undoLabel", { mins: minsLeft }) : t("common.undo"))}
              </Button>
            )}
            <button
              type="button"
              onClick={() => dismiss(n.id)}
              aria-label={t("a11y.dismiss")}
              className="min-h-[32px] min-w-[32px] rounded-md text-current opacity-70 hover:opacity-100"
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

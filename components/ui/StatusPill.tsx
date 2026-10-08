"use client";

import Badge from "./Badge";
import { useT } from "@/lib/i18n/client";

// The desk's StatusPill, keyed by this app's record states instead of appointment states.
export type PillStatus = "active" | "inactive" | "revoked" | "locked";

const META: Record<PillStatus, { icon: string; tone: "ok" | "done" | "neutral" | "bad" }> = {
  active: { icon: "●", tone: "ok" },
  inactive: { icon: "○", tone: "neutral" },
  revoked: { icon: "✕", tone: "neutral" },
  locked: { icon: "⚠", tone: "bad" },
};

// Status by color + icon + label (never color alone) — a11y requirement.
export default function StatusPill({ status }: { status: PillStatus }) {
  const { t, locale } = useT();
  const m = META[status] ?? META.active;
  return (
    <Badge tone={m.tone} icon={m.icon} lang={locale}>
      {t(`status.${status}`)}
    </Badge>
  );
}

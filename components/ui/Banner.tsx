import { IconAlert, IconOffline } from "./icons";

// The honest strip: offline, not-updating, migration missing. Sticky under the
// top bar, never a modal, never blank.
export default function Banner({
  tone = "warn",
  icon,
  children,
  action,
}: {
  tone?: "warn" | "bad" | "info";
  icon?: "offline" | "alert";
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  const cls = tone === "bad" ? "border-bad/30 bg-bad-wash text-bad-ink" : tone === "info" ? "border-brand/20 bg-brand-tint text-brand" : "border-warn/30 bg-warn-wash text-warn-ink";
  return (
    <div role="status" className={`flex items-center gap-3 rounded-xl border px-4 py-2.5 text-small ${cls}`}>
      <span className="shrink-0">{icon === "offline" ? <IconOffline /> : <IconAlert />}</span>
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

// Three empties: first-use, no-results, error. Same shape so the eye learns it.
export default function EmptyState({
  kind = "empty",
  title,
  body,
  action,
}: {
  kind?: "empty" | "no-results" | "error";
  title: React.ReactNode;
  body?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const tone = kind === "error" ? "border-bad/30 bg-bad-wash/40" : "border-dashed border-hairline-firm bg-surface/60";
  return (
    <div className={`rounded-xl2 border px-6 py-12 text-center ${tone}`} role={kind === "error" ? "alert" : undefined}>
      <div className="text-body font-medium text-ink">{title}</div>
      {body && <div className="mt-1 text-small text-muted">{body}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

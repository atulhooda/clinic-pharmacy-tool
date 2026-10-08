// Monospace uppercase micro-label — the brand's signature eyebrow / column head.
export default function MonoLabel({
  children,
  dot,
  className = "",
}: {
  children: React.ReactNode;
  dot?: "green" | "blue" | "amber" | "red";
  className?: string;
}) {
  const dotColor =
    dot === "green" ? "bg-ok" : dot === "blue" ? "bg-brand" : dot === "amber" ? "bg-warn" : dot === "red" ? "bg-bad" : "";
  return (
    <span className={`mono-label inline-flex items-center gap-1.5 ${className}`}>
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} aria-hidden />}
      {children}
    </span>
  );
}

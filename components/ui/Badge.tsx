// One chip shape, one status vocabulary. Colour + icon + label, never colour
// alone. Indic text inside a badge never gets uppercase or tracking.
export type Tone = "ok" | "warn" | "bad" | "done" | "brand" | "neutral" | "ink";

const TONE: Record<Tone, string> = {
  ok: "bg-ok-wash text-ok-ink",
  warn: "bg-warn-wash text-warn-ink",
  bad: "bg-bad-wash text-bad-ink",
  done: "bg-done-wash text-done",
  brand: "bg-brand-tint text-brand",
  neutral: "border border-hairline bg-surface text-muted",
  ink: "bg-ink text-white",
};

export default function Badge({
  tone = "neutral",
  icon,
  children,
  className = "",
  title,
  lang,
}: {
  tone?: Tone;
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  title?: string;
  lang?: string;
}) {
  return (
    <span
      title={title}
      lang={lang}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-micro font-semibold leading-5 ${TONE[tone]} ${className}`}
    >
      {icon && <span aria-hidden>{icon}</span>}
      {children}
    </span>
  );
}

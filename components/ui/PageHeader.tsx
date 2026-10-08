import MonoLabel from './MonoLabel';

// The desk's page head: a mono eyebrow with a dot, a big grotesk headline (optionally ending in
// the italic brand full stop), a muted subtitle, and the page's actions on the right.
export default function PageHeader({ eyebrow, dot = 'blue', title, accent = false, subtitle, actions }: {
  eyebrow: string;
  dot?: 'green' | 'blue' | 'amber' | 'red';
  title: string;
  accent?: boolean;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <MonoLabel dot={dot}>{eyebrow}</MonoLabel>
        <h1 className="mt-2 text-h1 md:text-display">
          {title}
          {accent && <span className="accent-serif">.</span>}
        </h1>
        {subtitle && <p className="mt-1 max-w-[70ch] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

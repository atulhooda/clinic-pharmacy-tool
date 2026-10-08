import MonoLabel from "@/components/ui/MonoLabel";

const TONES: Record<string, string> = {
  ink: "text-ink",
  brand: "text-brand",
  green: "text-ok",
  amber: "text-warn",
  red: "text-bad",
};

export default function KpiCard({
  label,
  value,
  unit,
  sub,
  tone = "ink",
  lang,
}: {
  label: string;
  value: string | number;
  unit?: string;
  sub?: string;
  tone?: "ink" | "brand" | "green" | "amber" | "red";
  lang?: string;
}) {
  return (
    <div className="card p-4 md:p-5">
      {lang && lang !== "en" ? (
        <div className="text-micro font-medium text-faint" lang={lang}>
          {label}
        </div>
      ) : (
        <MonoLabel>{label}</MonoLabel>
      )}
      <div className={`mt-2 text-[32px] font-extrabold leading-none tracking-tight tnum md:mt-3 md:text-[38px] ${TONES[tone]}`}>
        {value}
        {unit && <span className="text-h2 font-bold text-faint">{unit}</span>}
      </div>
      {sub && (
        <div className="mt-2 text-small text-muted" lang={lang}>
          {sub}
        </div>
      )}
    </div>
  );
}

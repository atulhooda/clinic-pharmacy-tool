/* eslint-disable @next/next/no-img-element */
// The Engageo lockup (copied with the UI kit from Ritu Desk; owned by this repo).
export default function Brand({ dark = false }: { dark?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/engageo-mark.svg" alt="Engageo" width={32} height={32} className="h-8 w-8 rounded-lg" />
      <span className={`text-h3 font-extrabold tracking-tight ${dark ? 'text-sidebar-text' : 'text-ink'}`}>Engageo</span>
    </div>
  );
}

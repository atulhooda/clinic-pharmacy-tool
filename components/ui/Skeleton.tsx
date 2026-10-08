// ═══════════════════════════════════════════════════════════════════════════
// PERCEIVED SPEED, WHICH IS THE ONLY SPEED A RECEPTIONIST EXPERIENCES.
//
// Every page is `force-dynamic` and server-renders against the database
// before Next sends a single byte. With no loading.tsx, App Router holds the
// OLD page on screen for that whole time — click Patients and nothing happens
// for a beat, so the app reads as frozen rather than busy.
//
// MEASURED 2026-08-02: ~450-500ms of server time even on /login, a prerendered
// page with no queries at all. That floor is the container, not our code.
//
// A loading.tsx turns the same wait into an instant page-shell swap. (Until
// 2026-09-12 the skeleton's background token did not exist, so every skeleton
// rendered blank — surface.raise is now defined in tailwind.config.ts.)
// ═══════════════════════════════════════════════════════════════════════════

export function Line({ w = "100%", h = 12 }: { w?: string; h?: number }) {
  return <div className="animate-pulse rounded bg-surface-raise" style={{ width: w, height: h }} aria-hidden />;
}

export function CardSkeleton() {
  return (
    <div className="card space-y-3 p-5">
      <Line w="45%" h={10} />
      <Line w="70%" h={26} />
      <Line w="55%" h={10} />
    </div>
  );
}

/** Page shell: eyebrow, headline, KPI row, body block. Matches the page layout
 *  closely enough that the real page does not visibly jump when it lands. */
export function PageSkeleton({ kpis = 4, rows = 6 }: { kpis?: number; rows?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="space-y-3">
        <Line w="180px" h={10} />
        <Line w="42%" h={34} />
        <Line w="30%" h={12} />
      </div>

      {kpis > 0 && (
        <div className="mt-7 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {Array.from({ length: kpis }).map((_, i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      )}

      <div className="card mt-6 divide-y divide-hairline">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-5 py-4">
            <Line w="90px" h={12} />
            <Line w="28%" h={12} />
            <div className="ml-auto">
              <Line w="70px" h={12} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

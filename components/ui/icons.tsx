// Small inline icon set (no dependency). 1.75 stroke, currentColor.
type P = { className?: string };
const base = (className?: string) => ({
  className,
  width: 18,
  height: 18,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
});

export const IconOverview = ({ className }: P) => (
  <svg {...base(className)}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></svg>
);
export const IconBell = ({ className }: P) => (
  <svg {...base(className)}><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16Z" /><path d="M10 20a2 2 0 0 0 4 0" /></svg>
);
export const IconToday = ({ className }: P) => (
  <svg {...base(className)}><rect x="3" y="4" width="18" height="17" rx="2" /><path d="M3 9h18M8 2v4M16 2v4" /><circle cx="12" cy="14" r="2.2" /></svg>
);
export const IconCallback = ({ className }: P) => (
  <svg {...base(className)}><path d="M5 4h3l1.6 4-2 1.2a12 12 0 0 0 5.2 5.2l1.2-2 4 1.6V19a2 2 0 0 1-2 2A15 15 0 0 1 4 6a2 2 0 0 1 1-2Z" /><path d="m15 3 5 5m0-5-5 5" /></svg>
);
export const IconPatients = ({ className }: P) => (
  <svg {...base(className)}><circle cx="9" cy="8" r="3.2" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 11a3 3 0 1 0-1-5.8M19.5 20a5.5 5.5 0 0 0-3.8-5.2" /></svg>
);
export const IconDoctor = ({ className }: P) => (
  <svg {...base(className)}><path d="M7 3v5a5 5 0 0 0 10 0V3" /><path d="M5 3h4M15 3h4" /><path d="M12 13v3a4 4 0 0 0 8 0v-1" /><circle cx="20" cy="13" r="1.6" /></svg>
);
export const IconPhone = ({ className }: P) => (
  <svg {...base(className)}><path d="M5 4h3l1.6 4-2 1.2a12 12 0 0 0 5.2 5.2l1.2-2 4 1.6V19a2 2 0 0 1-2 2A15 15 0 0 1 4 6a2 2 0 0 1 1-2Z" /></svg>
);
export const IconPlus = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 5v14M5 12h14" /></svg>
);
export const IconCheck = ({ className }: P) => (
  <svg {...base(className)}><path d="m20 6-11 11-5-5" /></svg>
);
export const IconClock = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
);
export const IconTrend = ({ className }: P) => (
  <svg {...base(className)}><path d="M3 17l6-6 4 4 7-8" /><path d="M21 7h-5m5 0v5" /></svg>
);
export const IconRupee = ({ className }: P) => (
  <svg {...base(className)}><path d="M7 5h10M7 9h10M16 5c0 4-3 5-7 5l6 9" /></svg>
);
export const IconRefresh = ({ className }: P) => (
  <svg {...base(className)}><path d="M21 12a9 9 0 1 1-2.6-6.4M21 4v5h-5" /></svg>
);
export const IconInsights = ({ className }: P) => (
  <svg {...base(className)}><path d="M3 3v18h18" /><rect x="7" y="11" width="3" height="6" rx="0.5" /><rect x="12" y="7" width="3" height="10" rx="0.5" /><rect x="17" y="13" width="3" height="4" rx="0.5" /></svg>
);
export const IconCalendar = ({ className }: P) => (
  <svg {...base(className)}><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 2.5v4M16 2.5v4" /></svg>
);
export const IconSettings = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.09a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
);
export const IconMore = ({ className }: P) => (
  <svg {...base(className)}><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></svg>
);
export const IconDots = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none" /></svg>
);
export const IconClose = ({ className }: P) => (
  <svg {...base(className)}><path d="M6 6l12 12M18 6 6 18" /></svg>
);
export const IconChevronLeft = ({ className }: P) => (
  <svg {...base(className)}><path d="m15 5-7 7 7 7" /></svg>
);
export const IconChevronRight = ({ className }: P) => (
  <svg {...base(className)}><path d="m9 5 7 7-7 7" /></svg>
);
export const IconChevronDown = ({ className }: P) => (
  <svg {...base(className)}><path d="m5 9 7 7 7-7" /></svg>
);
export const IconUndo = ({ className }: P) => (
  <svg {...base(className)}><path d="M9 14 4 9l5-5" /><path d="M4 9h10a6 6 0 0 1 0 12h-3" /></svg>
);
export const IconGlobe = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>
);
export const IconLogout = ({ className }: P) => (
  <svg {...base(className)}><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4" /><path d="m15 8 5 4-5 4M20 12H9" /></svg>
);
export const IconPrint = ({ className }: P) => (
  <svg {...base(className)}><path d="M7 8V3h10v5" /><rect x="4" y="8" width="16" height="9" rx="2" /><path d="M7 14h10v7H7z" /></svg>
);
export const IconWhatsApp = ({ className }: P) => (
  <svg {...base(className)}><path d="M20 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.2A8 8 0 1 1 20 11.5Z" /><path d="M9 9.5c.3 2 2.5 4.2 4.5 4.5l1.2-1.2-1.7-.8-.7.7c-.6-.3-1.4-1.1-1.7-1.7l.7-.7-.8-1.7L9 9.5Z" fill="currentColor" stroke="none" /></svg>
);
export const IconOffline = ({ className }: P) => (
  <svg {...base(className)}><path d="M2 8.5a16 16 0 0 1 20 0M5 12a11 11 0 0 1 14 0M8.5 15.5a6 6 0 0 1 7 0" /><circle cx="12" cy="19" r="1" fill="currentColor" /><path d="M3 3l18 18" /></svg>
);
export const IconAlert = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 3 2 20h20L12 3Z" /><path d="M12 9v5M12 17h.01" /></svg>
);
export const IconArrowRight = ({ className }: P) => (
  <svg {...base(className)}><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const IconSearch = ({ className }: P) => (
  <svg {...base(className)}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);

export const IconBox = ({ className }: P) => (
  <svg {...base(className)}><path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" /><path d="m3 8 9 5 9-5M12 13v8" /></svg>
);
export const IconTruck = ({ className }: P) => (
  <svg {...base(className)}><path d="M3 6h11v10H3zM14 9h4l3 3v4h-7" /><circle cx="7" cy="17.5" r="1.5" /><circle cx="17" cy="17.5" r="1.5" /></svg>
);
export const IconSliders = ({ className }: P) => (
  <svg {...base(className)}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>
);
export const IconInbox = ({ className }: P) => (
  <svg {...base(className)}><path d="M12 3v10M8 9l4 4 4-4" /><path d="M3 14h5l1.5 3h5L16 14h5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z" /></svg>
);
export const IconUser = ({ className }: P) => (
  <svg {...base(className)}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>
);

export const NAV_ICONS = {
  patients: IconPatients,
  insights: IconInsights,
  settings: IconSettings,
  more: IconMore,
} as const;

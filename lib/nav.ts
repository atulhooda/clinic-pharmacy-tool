import type { Permission } from './auth/permissions';

/**
 * ONE navigation array (the desk's shell pattern): the sidebar (≥1024px), the icon rail
 * (768–1023px) and the phone's bottom bar (<768px) all render from it, filtered by what the
 * signed-in person may open. Later milestones add Patients, Dispense and Registers here.
 */
export type IconKey = 'today' | 'box' | 'truck' | 'sliders' | 'settings' | 'inbox' | 'ledger';
export interface NavItem {
  key: string;
  href: string;
  icon: IconKey;
  label: string;
  /** The permission needed to see the item (none: everyone signed in). */
  permission?: Permission;
  /** Paths that light the item up (prefixes; '/' matches only itself). */
  match: string[];
  /** Shown only when this feature is on for the organisation (D-57: the desk sync). */
  feature?: 'deskSync';
}

export const NAV: readonly NavItem[] = [
  { key: 'stock', href: '/stock/items', icon: 'box', label: 'Stock', permission: 'stock.view', match: ['/stock/items'] },
  // Receiving and suppliers are one place: deliveries come from suppliers (founder, 2026-10-19).
  { key: 'receive', href: '/stock/receive', icon: 'inbox', label: 'Receive', permission: 'stock.view', match: ['/stock/receive', '/stock/suppliers'] },
  { key: 'desk-sales', href: '/stock/desk-sales', icon: 'today', label: 'Desk sales', permission: 'stock.view', match: ['/stock/desk-sales'], feature: 'deskSync' },
  { key: 'statement', href: '/stock/statement', icon: 'ledger', label: 'Statement', permission: 'stock.view', match: ['/stock/statement'] },
  { key: 'setup', href: '/stock/setup', icon: 'sliders', label: 'Dispensary', permission: 'stock.view', match: ['/stock/setup'] },
  { key: 'settings', href: '/settings', icon: 'settings', label: 'Settings', match: ['/settings', '/account'] },
];

export function navFor(permissions: readonly string[], features: { deskSync?: boolean } = {}): NavItem[] {
  return NAV.filter((n) => (!n.permission || permissions.includes(n.permission)) && (!n.feature || features[n.feature] === true));
}

export function isActive(path: string, n: NavItem): boolean {
  return n.match.some((m) => (m === '/' ? path === '/' : path === m || path.startsWith(`${m}/`)));
}

import type { Permission } from './auth/permissions';

/**
 * ONE navigation array (the desk's shell pattern): the sidebar (≥1024px), the icon rail
 * (768–1023px) and the phone's bottom bar (<768px) all render from it, filtered by what the
 * signed-in person may open. Later milestones add Patients, Dispense and Registers here.
 */
export type IconKey = 'today' | 'box' | 'truck' | 'sliders' | 'settings';
export interface NavItem {
  key: string;
  href: string;
  icon: IconKey;
  label: string;
  /** The permission needed to see the item (none: everyone signed in). */
  permission?: Permission;
  /** Paths that light the item up (prefixes; '/' matches only itself). */
  match: string[];
}

export const NAV: readonly NavItem[] = [
  { key: 'today', href: '/', icon: 'today', label: 'Today', match: ['/'] },
  { key: 'stock', href: '/stock/items', icon: 'box', label: 'Stock', permission: 'stock.view', match: ['/stock/items'] },
  { key: 'suppliers', href: '/stock/suppliers', icon: 'truck', label: 'Suppliers', permission: 'stock.view', match: ['/stock/suppliers'] },
  { key: 'setup', href: '/stock/setup', icon: 'sliders', label: 'Dispensary', permission: 'stock.view', match: ['/stock/setup'] },
  { key: 'settings', href: '/settings', icon: 'settings', label: 'Settings', match: ['/settings', '/account'] },
];

export function navFor(permissions: readonly string[]): NavItem[] {
  return NAV.filter((n) => !n.permission || permissions.includes(n.permission));
}

export function isActive(path: string, n: NavItem): boolean {
  return n.match.some((m) => (m === '/' ? path === '/' : path === m || path.startsWith(`${m}/`)));
}

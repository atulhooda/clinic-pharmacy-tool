/**
 * The route table (06a §12.1). Every method of every app/api/**\/route.ts must be listed
 * here; 06b DX-76 fails the build otherwise. A path whose methods need different access is listed
 * once per access rule. A route with a spec endpoint id must also
 * have at least one DX (cross-tenant isolation) row in 06b that names that id, and DX-77
 * drives every route against its access rule.
 */
import type { Permission } from './auth/permissions';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteEntry {
  path: string;
  methods: Method[];
  /**
   * 'public'; 'self' (needs a session; acts only on the caller); 'device' (needs a trusted-device
   * cookie, not a session: the lock screen); or the permission the route checks.
   */
  access: 'public' | 'self' | 'device' | { permission: Permission };
  /** The re-auth purpose whose grant the route consumes (06a §3.7), if any (06b DPN-11). */
  reauth?: string;
  /** The 06a §12.3 endpoint id (e.g. 'E-28'), or null for an operational route. */
  endpoint: string | null;
  /** Why an operational route (endpoint null) needs no isolation row. */
  isolationNote?: string;
}

export const ROUTES: readonly RouteEntry[] = [
  { path: '/api/health', methods: ['GET'], access: 'public', endpoint: null,
    isolationNote: 'returns only {ok, schemaVerified}; reads no tenant data' },
  { path: '/api/auth/context', methods: ['GET'], access: 'public', endpoint: 'A-01' },
  { path: '/api/auth/sign-in', methods: ['POST'], access: 'public', endpoint: 'A-02' },
  { path: '/api/auth/sign-out', methods: ['POST'], access: 'public', endpoint: 'A-06' },
  { path: '/api/auth/me', methods: ['GET'], access: 'self', endpoint: 'A-07' },
  { path: '/api/account/password', methods: ['PUT'], access: 'self', endpoint: 'A-13' },
  { path: '/api/account/sessions/revoke', methods: ['POST'], access: 'self', endpoint: 'A-16' },
  { path: '/api/auth/activity', methods: ['POST'], access: 'self', endpoint: 'A-08' },
  { path: '/api/auth/lock', methods: ['POST'], access: 'self', endpoint: 'A-09' },
  { path: '/api/auth/device/people', methods: ['GET'], access: 'device', endpoint: 'A-10' },
  { path: '/api/auth/device/switch', methods: ['POST'], access: 'device', endpoint: 'A-11' },
  { path: '/api/auth/reauth', methods: ['POST'], access: 'self', endpoint: 'A-12' },
  { path: '/api/account/switch-pin', methods: ['PUT'], access: 'self', endpoint: 'A-14' },
  { path: '/api/account/signing-pin', methods: ['PUT'], access: 'self', endpoint: 'A-15' },
  { path: '/api/devices', methods: ['GET'], access: { permission: 'devices.manage' }, endpoint: 'M-10' },
  { path: '/api/devices', methods: ['POST'], access: { permission: 'devices.manage' }, endpoint: 'M-10', reauth: 'devices.register' },
  { path: '/api/devices/[id]/revoke', methods: ['POST'], access: { permission: 'devices.manage' }, endpoint: 'M-11' },
  { path: '/api/org/settings', methods: ['GET'], access: { permission: 'org.settings' }, endpoint: 'M-01' },
  { path: '/api/org/settings', methods: ['PUT'], access: { permission: 'org.settings' }, endpoint: 'M-01', reauth: 'org.settings' },
  { path: '/api/premises', methods: ['GET'], access: 'self', endpoint: 'M-02' },
  { path: '/api/premises', methods: ['POST'], access: { permission: 'org.settings' }, endpoint: 'M-03', reauth: 'org.settings' },
  { path: '/api/premises/[id]', methods: ['PATCH'], access: { permission: 'org.settings' }, endpoint: 'M-04', reauth: 'org.settings' },
  { path: '/api/staff', methods: ['GET'], access: { permission: 'staff.manage' }, endpoint: 'M-05' },
  { path: '/api/staff', methods: ['POST'], access: { permission: 'staff.manage' }, endpoint: 'M-05', reauth: 'staff.manage' },
  { path: '/api/staff/[id]', methods: ['GET'], access: { permission: 'staff.manage' }, endpoint: 'M-06' },
  { path: '/api/staff/[id]', methods: ['PATCH'], access: { permission: 'staff.manage' }, endpoint: 'M-06', reauth: 'staff.manage' },
  { path: '/api/staff/[id]/reset', methods: ['POST'], access: { permission: 'staff.manage' }, endpoint: 'M-07', reauth: 'staff.manage' },
  { path: '/api/staff/[id]/sessions/revoke', methods: ['POST'], access: { permission: 'staff.manage' }, endpoint: 'M-08' },
  { path: '/api/roles', methods: ['GET'], access: { permission: 'roles.manage' }, endpoint: 'M-09' },
  { path: '/api/roles', methods: ['POST'], access: { permission: 'roles.manage' }, endpoint: 'M-09', reauth: 'roles.manage' },
  { path: '/api/roles/[key]', methods: ['PATCH'], access: { permission: 'roles.manage' }, endpoint: 'M-09', reauth: 'roles.manage' },
  { path: '/api/audit', methods: ['GET'], access: { permission: 'audit.view' }, endpoint: 'M-12' },
  { path: '/api/dispensary/settings', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-01' },
  { path: '/api/dispensary/settings', methods: ['PUT'], access: { permission: 'stock.settings' }, endpoint: 'E-03' },
  { path: '/api/dispensary/setup', methods: ['POST'], access: { permission: 'stock.settings' }, endpoint: 'E-02' },
  { path: '/api/dispensary/premises', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-04' },
  { path: '/api/dispensary/premises/[id]/setup', methods: ['POST'], access: { permission: 'stock.settings' }, endpoint: 'E-05', reauth: 'premises.legal_settings' },
  { path: '/api/dispensary/premises/[id]/settings', methods: ['PUT'], access: { permission: 'stock.settings' }, endpoint: 'E-06', reauth: 'premises.legal_settings' },
  { path: '/api/dispensary/locations/[id]', methods: ['PATCH'], access: { permission: 'stock.settings' }, endpoint: 'E-07' },
  { path: '/api/dispensary/master', methods: ['GET'], access: 'self', endpoint: 'E-08' },
  { path: '/api/dispensary/master/[id]', methods: ['GET'], access: 'self', endpoint: 'E-09' },
  { path: '/api/dispensary/items', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-12' },
  { path: '/api/dispensary/items', methods: ['POST'], access: { permission: 'stock.items' }, endpoint: 'E-13' },
  { path: '/api/dispensary/items/[id]', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-14' },
  { path: '/api/dispensary/items/[id]', methods: ['PATCH'], access: { permission: 'stock.items' }, endpoint: 'E-15' },
  { path: '/api/dispensary/items/[id]/movements', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-18' },
  { path: '/api/dispensary/items/[id]/units', methods: ['POST'], access: { permission: 'stock.items' }, endpoint: 'E-16' },
  { path: '/api/dispensary/items/[id]/units/[unitId]', methods: ['PATCH'], access: { permission: 'stock.items' }, endpoint: 'E-17' },
  { path: '/api/dispensary/goods-receipts', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-23' },
  { path: '/api/dispensary/goods-receipts', methods: ['POST'], access: { permission: 'stock.receive' }, endpoint: 'E-23' },
  { path: '/api/dispensary/goods-receipts/read-bill', methods: ['POST'], access: { permission: 'stock.receive' }, endpoint: 'E-51' },
  { path: '/api/dispensary/goods-receipts/[id]', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-24' },
  { path: '/api/dispensary/goods-receipts/[id]', methods: ['PATCH'], access: { permission: 'stock.receive' }, endpoint: 'E-24' },
  { path: '/api/dispensary/goods-receipts/[id]/post', methods: ['POST'], access: { permission: 'stock.receive' }, endpoint: 'E-25' },
  { path: '/api/dispensary/goods-receipts/[id]/discard', methods: ['POST'], access: { permission: 'stock.receive' }, endpoint: 'E-26' },
  { path: '/api/dispensary/adjustments', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-34' },
  { path: '/api/dispensary/adjustments', methods: ['POST'], access: { permission: 'stock.adjust' }, endpoint: 'E-34' },
  { path: '/api/dispensary/adjustments/[id]', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-34' },
  { path: '/api/dispensary/items/[id]/batch-hint', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-34' },
  { path: '/api/dispensary/reports/stock-statement', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-45' },
  { path: '/api/dispensary/suppliers', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-20' },
  { path: '/api/dispensary/suppliers', methods: ['POST'], access: { permission: 'stock.items' }, endpoint: 'E-20' },
  { path: '/api/dispensary/suppliers/[id]', methods: ['GET'], access: { permission: 'stock.view' }, endpoint: 'E-21' },
  { path: '/api/dispensary/suppliers/[id]', methods: ['PATCH'], access: { permission: 'stock.items' }, endpoint: 'E-21' },
];

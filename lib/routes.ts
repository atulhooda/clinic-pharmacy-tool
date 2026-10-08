/**
 * The route table (06a §12.1). Every method of every app/api/**\/route.ts must be listed
 * here; 06b DX-76 fails the build otherwise. A route with a spec endpoint id must also
 * have at least one DX (cross-tenant isolation) row in 06b that names that id, and DX-77
 * drives every route against its access rule.
 */
import type { Permission } from './auth/permissions';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteEntry {
  path: string;
  methods: Method[];
  /** 'public', 'self' (needs a session; acts only on the caller), or the permission the route checks. */
  access: 'public' | 'self' | { permission: Permission };
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
];

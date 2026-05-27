// Per-tenant role-based access control policy. Mirror of ledger-core's
// src/lib/auth/policy.ts — same hierarchy, same named permissions.
//
// revenue-rec's actions: extract contracts via AI, approve extractions,
// post recognition JEs through the bridge. All MEMBER+. VIEWER refused.

import type { TenantRole } from "@prisma/client";

const ROLE_RANK: Record<TenantRole, number> = {
  VIEWER: 0,
  MEMBER: 1,
  ADMIN:  2,
  OWNER:  3,
};

function meets(actual: TenantRole | undefined | null, required: TenantRole): boolean {
  if (!actual) return false;
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

// READ
export const canViewReports = (role: TenantRole | undefined | null): boolean =>
  meets(role, "VIEWER");

// WRITE — MEMBER+ for the AI + posting surfaces.
export const canExtractContract = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canApproveExtraction = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

export const canPostRecognition = (role: TenantRole | undefined | null): boolean =>
  meets(role, "MEMBER");

// ADMIN — kept for future use; revenue-rec has no admin pages today.
export const canViewAdminPages = (role: TenantRole | undefined | null): boolean =>
  meets(role, "ADMIN");

export class PermissionDeniedError extends Error {
  constructor(public readonly permission: string, public readonly role: TenantRole | null) {
    super(
      role
        ? `This action requires a higher role than ${role}. (permission: ${permission})`
        : `This action requires being signed in to a tenant. (permission: ${permission})`
    );
    this.name = "PermissionDeniedError";
  }
}

export function requirePermission(
  permission: string,
  role: TenantRole | null,
  check: (r: TenantRole | null) => boolean
): void {
  if (!check(role)) throw new PermissionDeniedError(permission, role);
}

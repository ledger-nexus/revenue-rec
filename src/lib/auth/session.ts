// Tenant-aware session helpers for revenue-rec's Server Actions.
// Mirror of recon's session.ts. See that file for full design rationale.

import { prisma } from "@/lib/db";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
}

export interface CurrentTenant {
  id: string;
  slug: string;
  name: string;
  role: string;
}

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated — sign in first");
    this.name = "NotAuthenticatedError";
  }
}

export class NoTenantSelectedError extends Error {
  constructor() {
    super(
      "No active tenant — you're not a member of any tenant, or you're a member of multiple and need to pick one"
    );
    this.name = "NoTenantSelectedError";
  }
}

export async function getCurrentUser(): Promise<CurrentUser | null> {
  const email = await resolveClerkEmail();
  if (!email) return null;
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, displayName: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return { id: user.id, email: user.email, displayName: user.displayName };
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new NotAuthenticatedError();
  return u;
}

export async function getCurrentTenant(): Promise<CurrentTenant | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const memberships = await prisma.tenantMembership.findMany({
    where: { userId: user.id },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
  });
  if (memberships.length !== 1) return null;
  const m = memberships[0];
  return {
    id: m.tenant.id,
    slug: m.tenant.slug,
    name: m.tenant.name,
    role: m.role,
  };
}

export async function requireCurrentTenant(): Promise<CurrentTenant> {
  await requireCurrentUser();
  const t = await getCurrentTenant();
  if (!t) throw new NoTenantSelectedError();
  return t;
}

async function resolveClerkEmail(): Promise<string | null> {
  if (!process.env.CLERK_SECRET_KEY) return null;
  try {
    const { auth, clerkClient } = await import("@clerk/nextjs/server");
    const { userId } = await auth();
    if (!userId) return null;
    const client = await clerkClient();
    const u = await client.users.getUser(userId);
    return u.primaryEmailAddress?.emailAddress ?? null;
  } catch {
    return null;
  }
}

// Plan-based repo access gate. Mirror of recon's repo-access.ts —
// revenue-rec is included only on Growth + Scale plans.
//
// See recon/src/lib/auth/repo-access.ts for the full design rationale.

import type { CurrentTenant } from "./session";

const THIS_REPO_NAME = "revenue-rec";

// Plans that include this repo. Mirror of ledger-core's plans.ts.
const PLANS_INCLUDING_THIS_REPO: ReadonlySet<string> = new Set([
  "growth",
  "scale",
]);

export class RepoNotIncludedError extends Error {
  constructor(
    public readonly currentPlan: string,
    public readonly repoName: string
  ) {
    super(
      `The ${repoName} module is not included in your "${currentPlan}" plan. Upgrade to Growth or Scale at /admin/billing.`
    );
    this.name = "RepoNotIncludedError";
  }
}

export interface RepoAccessView {
  included: boolean;
  currentPlan: string;
  repoName: string;
}

function isEnforcementOn(): boolean {
  return process.env.BILLING_ENFORCE_LIMITS === "true";
}

function effectivePlan(tenant: CurrentTenant): string {
  const status = tenant.subscriptionStatus;
  if (status === "active" || status === "trialing") {
    return tenant.billingPlan ?? "free";
  }
  return "free";
}

export function getRepoAccess(tenant: CurrentTenant): RepoAccessView {
  const currentPlan = effectivePlan(tenant);
  return {
    included: PLANS_INCLUDING_THIS_REPO.has(currentPlan),
    currentPlan,
    repoName: THIS_REPO_NAME,
  };
}

export function requireRepoAccess(tenant: CurrentTenant): void {
  const access = getRepoAccess(tenant);
  if (access.included) return;
  if (!isEnforcementOn()) {
    console.warn(
      `[repo-access] tenant=${tenant.id} would-block ${THIS_REPO_NAME} ` +
        `access on ${access.currentPlan} plan; soft mode`
    );
    return;
  }
  throw new RepoNotIncludedError(access.currentPlan, THIS_REPO_NAME);
}

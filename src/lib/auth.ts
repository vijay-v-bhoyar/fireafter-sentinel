import { getSupabaseServerClient } from "./supabase";
import { SIGN_OUT_UNCONFIRMED_MESSAGE } from "./logout-contract";
import {
  getDefaultOrganizationMembership,
  getIncidentAuthorizationContext,
  getRecommendationAuthorizationContext,
} from "./fireafter-supabase";

type OrganizationRole = "incident_commander" | "analyst" | "viewer";

export type CurrentUser = {
  id: string;
  email: string;
  organizationId: string | null;
  role: OrganizationRole | null;
};

export async function getCurrentUser(): Promise<CurrentUser | null> {
  return (await createCurrentUserReader())();
}

/** Capture the request cookie client before a streamed response leaves route scope. */
export async function createCurrentUserReader() {
  const supabase = await getSupabaseServerClient();
  return () => readCurrentUser(supabase);
}

async function readCurrentUser(supabase: Awaited<ReturnType<typeof getSupabaseServerClient>>): Promise<CurrentUser | null> {
  if (!supabase) return null;

  let user;
  let error;
  try {
    ({
      data: { user },
      error,
    } = await supabase.auth.getUser());
  } catch (error) {
    console.warn("[fireafter] current user lookup unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
  if (error || !user) return null;

  let membership;
  try {
    membership = await getDefaultOrganizationMembership(user.id);
  } catch (error) {
    console.warn("[fireafter] current user membership lookup unavailable", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }

  return {
    id: user.id,
    email: user.email ?? "authenticated responder",
    organizationId: membership?.organization_id ?? null,
    role: membership?.role ?? null,
  };
}

export async function requireCurrentUser() {
  const user = await getCurrentUser();
  if (!user) {
    throw new AuthError("Authentication required", 401);
  }
  if (!user.role || !["incident_commander", "analyst"].includes(user.role)) {
    throw new AuthError("Organization membership required", 403);
  }
  return user;
}

export async function requireIncidentAccess(
  incidentId: string,
  roles: OrganizationRole[] = ["incident_commander", "analyst"],
) {
  const user = await requireCurrentUser();
  assertUserRole(user, roles);

  const context = await getIncidentAuthorizationContext(incidentId);
  if (!context) {
    throw new AuthError("Incident not found", 404);
  }
  if (!user.organizationId || context.organizationId !== user.organizationId) {
    throw new AuthError("Incident access denied", 403);
  }
  return user;
}

export async function requireRecommendationAccess(
  recommendationId: string,
  roles: OrganizationRole[] = ["incident_commander", "analyst"],
) {
  const user = await requireCurrentUser();
  assertUserRole(user, roles);

  const context = await getRecommendationAuthorizationContext(recommendationId);
  if (!context) {
    throw new AuthError("Recommendation not found", 404);
  }
  if (!user.organizationId || context.organizationId !== user.organizationId) {
    throw new AuthError("Incident access denied", 403);
  }
  return user;
}

export async function signInWithPassword(input: {
  email: string;
  password: string;
}) {
  const supabase = await getSupabaseServerClient();
  if (!supabase) {
    throw new AuthError(
      "Supabase Auth is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (or NEXT_PUBLIC_SUPABASE_ANON_KEY).",
      503,
    );
  }

  const unavailable = "Sign-in could not be confirmed because the authentication service is unavailable or took too long. Please try again shortly.";
  let result: Awaited<ReturnType<typeof supabase.auth.signInWithPassword>>;
  try {
    result = await supabase.auth.signInWithPassword(input);
  } catch {
    throw new AuthError(unavailable, 503);
  }
  const { data, error } = result;
  if (error && (error.name === "AuthRetryableFetchError" || error.status === 0 || (error.status ?? 0) >= 500)) {
    throw new AuthError(unavailable, 503);
  }
  if (error?.status === 429) {
    throw new AuthError("Too many sign-in attempts. Please wait before trying again.", 429);
  }
  if (error || !data.user) {
    throw new AuthError(error?.message ?? "Invalid email or password", 401);
  }

  return data.user;
}

export async function verifySignedInOrganizationMembership(userId: string) {
  let membership;
  try {
    membership = await getDefaultOrganizationMembership(userId);
  } catch (error) {
    console.error("[fireafter] authenticated membership verification failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    await clearSessionAfterLoginFailure();
    throw new AuthError(
      "Unable to verify FireAfter organization access. Try again or ask an operator to reissue this account.",
      503,
    );
  }

  const supportedRoles = ["incident_commander", "analyst", "viewer"] as const;
  if (
    !membership ||
    membership.user_id !== userId ||
    !supportedRoles.includes(membership.role)
  ) {
    await clearSessionAfterLoginFailure();
    throw new AuthError(
      "Account authenticated, but no valid FireAfter organization membership was found. Ask an operator to issue or reissue this account.",
      403,
    );
  }

  return membership;
}

export async function signOutCurrentUser() {
  try {
    const supabase = await getSupabaseServerClient({ requireCookieWrites: true });
    if (!supabase) throw new Error("Auth unavailable");
    const result = await supabase.auth.signOut({ scope: "global" });
    if (result?.error !== null) throw new Error("Sign-out not confirmed");
  } catch {
    throw new AuthError(SIGN_OUT_UNCONFIRMED_MESSAGE, 503);
  }
}

async function clearSessionAfterLoginFailure() {
  try {
    await signOutCurrentUser();
  } catch (error) {
    console.warn("[fireafter] could not clear unverified login session", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
  }
}

export class AuthError extends Error {
  constructor(
    message: string,
    public status = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function assertUserRole(user: CurrentUser, roles: OrganizationRole[]) {
  if (!user.role || !roles.includes(user.role)) {
    throw new AuthError("Organization membership required", 403);
  }
}

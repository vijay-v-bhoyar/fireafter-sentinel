// Explicit in-memory test transport, never imported by the operator CLI.
import { accountEmailHash, ACCOUNT_RECOVERY_VERSION } from "./operator-account-coordinator.mjs";
export const NEW_USER_ID = "71000000-0000-4000-8000-000000000001";
export const EXISTING_USER_ID = "71000000-0000-4000-8000-000000000002";
export const OPERATOR_USER_ID = "72000000-0000-4000-8000-000000000001";
const org = "f5cabbf4-8e88-5f01-af0c-15e201847c49";

export function createIssuanceFixture(existingUser = null, failingTable = null, membershipRole = "incident_commander", authenticatedRole = membershipRole) {
  const calls = [], faults = new Map(), attempts = new Map();
  const state = { user: existingUser, password: "old credential", memberVersion: existingUser ? 1 : null, memberRole: membershipRole, operatorUserId: OPERATOR_USER_ID };
  let readCount = 0;
  const fault = (stage, after) => {
    if (faults.get(stage) === after) { faults.delete(stage); throw new Error("internal database detail"); }
  };
  const event = (a, event_type) => calls.push({ type: "insert", table: "operator_account_issuance_events",
    values: { attempt_id: a.attemptId, account_email_hash: a.emailHash, operator_user_id: a.operatorUserId,
      operator_identity_source: "authenticated_supabase_user", event_type } });
  const fixture = {
    calls, attempts, state,
    failNext(stage, afterCommit = false) { faults.set(stage, afterCommit); },
    auth: {
      admin: {
        async listUsers() { return { data: { users: state.user ? [state.user] : [] }, error: null }; },
        async createUser(payload) {
          calls.push({ type: "createUser", payload }); fault("createUser", false);
          state.user = { id: NEW_USER_ID, email: payload.email, app_metadata: payload.app_metadata };
          state.password = payload.password; fault("createUser", true);
          return { data: { user: state.user }, error: null };
        },
        async updateUserById(id, payload) {
          calls.push({ type: "updateUserById", id, payload }); fault("updateUserById", false);
          state.user = { ...state.user, id, app_metadata: payload.app_metadata }; state.password = payload.password;
          fault("updateUserById", true); return { data: { user: state.user }, error: null };
        },
      },
      async signInWithPassword(payload) {
        calls.push({ type: "signInWithPassword", payload }); fault("login", false);
        if (payload.email?.toLowerCase() === "operator@example.com" && payload.password === "operator password 123!") {
          return { data: { user: { id: OPERATOR_USER_ID, email: "operator@example.com" }, session: { access_token: "test-only-operator-token" } }, error: null };
        }
        if (payload.password !== state.password) return { error: new Error("provider password detail") };
        return { data: { user: state.user, session: { access_token: "test-only-token" } }, error: null };
      },
    },
    rpc(name, args) {
      const stage = name.includes("begin") ? "begin" : name.includes("get") ? "status" : args.p_phase;
      const query = { abortSignal() { return query; }, async retry(enabled) {
        if (enabled !== false) throw new Error("test expects SDK retries disabled");
        calls.push({ type: "rpc", stage, args });
        try {
          fault(stage, false);
          if (stage === "begin" && failingTable === "operator_account_issuance_events") throw new Error("internal database detail");
          let a = attempts.get(args.p_attempt_id), claimed = false;
          if (stage === "begin") {
            if (a) {
              if (a.emailHash !== accountEmailHash(args.p_email) || a.organizationId !== args.p_organization_id ||
                a.requestedRole !== args.p_requested_role || a.operatorUserId !== state.operatorUserId) throw new Error("conflict");
            } else {
              if ([...attempts.values()].some(value => value.emailHash === accountEmailHash(args.p_email) && value.state !== "succeeded")) throw new Error("pending");
              a = { version: ACCOUNT_RECOVERY_VERSION, attemptId: args.p_attempt_id, organizationId: args.p_organization_id,
                emailHash: accountEmailHash(args.p_email), requestedRole: args.p_requested_role,
                databaseRole: { responder: "incident_commander", reviewer: "analyst", viewer: "viewer" }[args.p_requested_role],
                operatorIdentity: state.operatorUserId, operatorUserId: state.operatorUserId,
                operatorIdentitySource: "authenticated_supabase_user", state: "auth_pending", userId: null,
                created: args.p_existing_user_id === null, claimed: false, startedAt: "2026-09-14T14:00:00.000Z", completedAt: null };
              attempts.set(a.attemptId, a); a.memberVersion = state.memberVersion;
              calls.push({ type: "upsert", table: "organizations", values: { id: a.organizationId } }); event(a, "started"); claimed = true;
            }
          } else if (stage !== "status") {
            if (!a) throw new Error("missing");
            if (a.state !== "succeeded") {
              if (state.user?.id !== args.p_user_id || state.user.app_metadata?.fireafter_issuance_attempt_id !== a.attemptId || a.memberVersion !== state.memberVersion) throw new Error("conflict");
              if (stage === "membership" && a.state === "auth_pending") {
                calls.push({ type: "upsert", table: "organization_members", values: { user_id: args.p_user_id, role: a.databaseRole } });
                if (failingTable === "organization_members") throw new Error("internal database detail");
                a.state = "membership_committed"; a.userId = args.p_user_id;
                state.memberVersion = (state.memberVersion ?? 0) + 1; a.memberVersion = state.memberVersion;
              } else if (stage === "succeeded") {
                if (a.state !== "membership_committed") throw new Error("wrong phase");
                a.state = "succeeded"; a.completedAt = "2026-09-14T14:00:01.000Z"; event(a, "succeeded");
              }
            }
          }
          fault(stage, true);
          if (!a) return { data: null, error: null };
          const data = { ...a, claimed }; delete data.memberVersion;
          return { data, error: null };
        } catch (error) { return { data: null, error }; }
      } };
      return query;
    },
    from(table) {
      const query = { select() { return query; }, eq() { return query; }, async maybeSingle() {
        calls.push({ type: "maybeSingle", table });
        return { data: { organization_id: org, user_id: state.user?.id ?? NEW_USER_ID,
          role: readCount++ === 0 ? state.memberRole : authenticatedRole }, error: null };
      } };
      return query;
    },
  };
  return fixture;
}

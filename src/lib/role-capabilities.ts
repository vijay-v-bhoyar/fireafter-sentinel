export type OperationalUser =
  | {
      organizationId?: string | null;
      role?: "incident_commander" | "analyst" | "viewer" | null;
    }
  | null
  | undefined;

export function canWriteOperationalRecords(user: OperationalUser) {
  return Boolean(
    user?.organizationId &&
      (user.role === "incident_commander" || user.role === "analyst"),
  );
}

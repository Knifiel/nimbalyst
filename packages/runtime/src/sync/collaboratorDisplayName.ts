/**
 * The label other people see on a collaborator's cursor and presence chip.
 *
 * Name, then email, then a generic label. Never the team member id: a
 * `member-live-...` Stytch id means nothing to the person reading it, and
 * several hosts used it as the fallback when a name had not resolved yet. A
 * name equal to the member id is one of those fallbacks, already flattened
 * into a string, so it counts as no name.
 */
export const UNNAMED_COLLABORATOR_LABEL = 'Teammate';

export interface CollaboratorIdentity {
  name?: string | null;
  email?: string | null;
  // identity-scope-allow: only compared against the name to reject a member-id fallback; never authorizes
  memberId?: string | null;
}

export function collaboratorDisplayName(identity: CollaboratorIdentity): string {
  const memberId = identity.memberId?.trim();
  for (const candidate of [identity.name, identity.email]) {
    const value = candidate?.trim();
    if (value && value !== memberId) return value;
  }
  return UNNAMED_COLLABORATOR_LABEL;
}

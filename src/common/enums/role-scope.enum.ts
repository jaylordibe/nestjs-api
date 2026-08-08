// The two authorization scopes a role can live in.
//
// PLATFORM roles are global — they grant authority over the whole service
// and are assigned through `user_roles`. BUSINESS roles are tenant-local —
// they grant authority only inside one business and are assigned through
// `business_memberships`.
//
// Scope integrity is enforced in `AbilityFactory`, which drops any permission
// whose scope does not match the branch it arrived in — not by a database
// constraint. The escalation that matters is on the READ path: the platform
// branch emits an UNCONDITIONAL rule, and business permissions are always
// `ANY`, so a business role assigned platform-wide would grant authority over
// every tenant. A constraint guards the write only, and cannot see a grant set
// arriving from the Redis cache. The write path validates too — see
// `UserRolesService.loadPlatformRole` and `loadAssignableBusinessRole`.
export enum RoleScope {
  PLATFORM = 'platform',
  BUSINESS = 'business',
}

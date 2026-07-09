// The two authorization scopes a role can live in.
//
// PLATFORM roles are global — they grant authority over the whole service
// and are assigned through `user_roles`. BUSINESS roles are tenant-local —
// they grant authority only inside one business and are assigned through
// `business_members`.
//
// A database constraint (see the init migration) makes it impossible for
// `user_roles` to reference a BUSINESS role, or `business_members` a
// PLATFORM one.
export enum RoleScope {
  PLATFORM = 'platform',
  BUSINESS = 'business',
}

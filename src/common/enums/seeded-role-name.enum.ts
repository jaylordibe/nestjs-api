// The roles the seeder installs on every deployment. These are `isSystem`
// rows: catalog-owned, immutable through the API, and their permission sets
// are reconciled from ROLE_DEFINITION_CATALOG on every `yarn prisma:seed`.
//
// Operators may create additional roles at runtime; those are ordinary data
// and are editable. Only the ones listed here are managed by code.
export enum SeededRoleName {
  PLATFORM_ADMIN = 'platform_admin',
  PLATFORM_SUPPORT = 'platform_support',
  PLATFORM_DEVELOPER = 'platform_developer',
  // Assigned to every registered user. Carries the self-service grants that
  // make `/users/me/*` and device-token management work without any staff or
  // business role.
  PLATFORM_USER = 'platform_user',

  BUSINESS_OWNER = 'business_owner',
  BUSINESS_ADMIN = 'business_admin',
  BUSINESS_MANAGER = 'business_manager',
  BUSINESS_STAFF = 'business_staff',
}

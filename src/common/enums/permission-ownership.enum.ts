// Whether a permission applies to every row of its subject, or only to the
// rows the acting user owns.
//
// This is the discriminator that lets the permission table stay condition-free:
// the row records *what* (action + subject), and `AbilityFactory` derives the
// *where* from it. `ANY` in PLATFORM scope produces an unconditional CASL rule;
// `OWN` produces a rule conditioned on the acting user's id (`{ id: userId }`
// for User, `{ userId }` for DeviceToken — see SUBJECT_OWNER_KEY).
//
// In BUSINESS scope the condition is always the tenant, so business-scoped
// permissions are always `ANY`.
//
// The `own` / `any` split is a well-established capability pattern (Drupal's
// `edit_own_node` vs `edit_any_node`, Auth0's `update:own` vs `update:any`).
export enum PermissionOwnership {
  OWN = 'own',
  ANY = 'any',
}

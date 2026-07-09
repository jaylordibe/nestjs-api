// `BusinessMember` → `business_member`, `assignRole` → `assign_role`,
// `all` → `all`. Handles PascalCase and camelCase; consecutive capitals in
// an acronym collapse into one segment (`deviceOSVersion` → `device_os_version`).
export function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

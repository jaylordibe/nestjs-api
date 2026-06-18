import type { ValidationError } from '@nestjs/common';

export interface ValidationFailureDetail {
  field: string;
  constraints: string[];
}

// class-validator emits a tree of ValidationErrors: leaf failures live in
// `.constraints`; structural nesting (objects under `@ValidateNested`, array
// items under `@ValidateNested({ each: true })`) lives in `.children`. Walk
// the tree depth-first and project it onto the public details contract from
// `src/common/errors/README.md`:
//
//   details: Array<{ field: string; constraints: string[] }>
//
// Paths use the standard form-name convention so frontends can map directly
// onto their inputs:
//   - object keys are dot-joined          (`address.street`)
//   - array indices use brackets          (`passengers[0]`)
//   - leaves combine the two              (`passengers[0].firstName`)
//
// Container nodes that only carry children (no own constraints) are path
// segments, not failures — they're not emitted on their own.
export function flattenValidationErrors(
  errors: readonly ValidationError[],
  parentPath = '',
): ValidationFailureDetail[] {
  const out: ValidationFailureDetail[] = [];
  for (const err of errors) {
    const isIndex = /^\d+$/.test(err.property);
    const segment = isIndex ? `[${err.property}]` : err.property;
    const path = parentPath
      ? isIndex
        ? `${parentPath}${segment}`
        : `${parentPath}.${segment}`
      : segment;

    if (err.constraints && Object.keys(err.constraints).length > 0) {
      out.push({ field: path, constraints: Object.values(err.constraints) });
    }
    if (err.children && err.children.length > 0) {
      out.push(...flattenValidationErrors(err.children, path));
    }
  }
  return out;
}

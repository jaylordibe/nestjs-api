// Optional per-value presentation overrides for an enum option, attached in the
// enums registry only where humanize() would produce the wrong label (acronym
// casing like iOS/macOS, a hand-written description, etc.). Both fields are
// optional; an absent override falls back to the humanized enum value.
export interface EnumOptionMeta {
  label?: string;
  description?: string;
}

// One option inside an enum's option list. `value` is the wire value the API
// stores/accepts; `label` is presentational only (frontend i18n can replace it
// keyed off `value`); `description` is null when the enum has no metadata map;
// `sortOrder` is the enum's declaration order (1-based). Every enum endpoint
// emits this same shape, so clients use one type across all `/api/enums/*`.
export class EnumOptionDto {
  value!: string;
  label!: string;
  description!: string | null;
  sortOrder!: number;

  constructor(init: {
    value: string;
    label: string;
    description?: string;
    sortOrder: number;
  }) {
    this.value = init.value;
    this.label = init.label;
    this.description = init.description ?? null;
    this.sortOrder = init.sortOrder;
  }
}

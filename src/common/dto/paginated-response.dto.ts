export class PaginationMeta {
  page!: number;
  perPage!: number;
  total!: number;
  totalPages!: number;
}

export class PaginatedResponseDto<T> {
  data!: T[];
  meta!: PaginationMeta;
}

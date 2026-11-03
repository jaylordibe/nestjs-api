/** A file attached to a resource, with a short-lived URL to read it. */
export class AttachedFileResponseDto {
  id!: string;
  /** The type the server identified from the file's content. */
  contentType!: string;
  width!: number | null;
  height!: number | null;
  /**
   * A signed URL that reads the file until `urlExpiresAt`. Minted only after
   * the caller was authorized to read the resource it belongs to. It is a
   * bearer credential — do not log or share it; read the resource again for a
   * fresh one.
   */
  url!: string;
  /** When `url` stops working. */
  urlExpiresAt!: Date;

  constructor(fields: AttachedFileResponseDto) {
    Object.assign(this, fields);
  }
}

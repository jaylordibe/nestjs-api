import { ApiProperty } from '@nestjs/swagger';

export class QueueSummaryDto {
  name!: string;
  waiting!: number;
  active!: number;
  completed!: number;
  failed!: number;
  delayed!: number;
}

/**
 * One background job, as an operator sees it.
 *
 * `payload` is the field this whole module is shaped around. It carries
 * whatever the enqueuing request supplied — email addresses, note text,
 * identifiers — so it is included ONLY for a caller holding `readPayload
 * QueueJob`. Support roles investigate why a job failed; they do not read the
 * user data it was carrying.
 *
 * The distinction is enforced by omitting the key entirely rather than by
 * masking it. A `payload: '[redacted]'` placeholder still tells the reader a
 * payload existed and how the redaction is spelled, and every masking scheme
 * eventually leaks its own length or shape.
 */
export class QueueJobResponseDto {
  id!: string;
  name!: string;
  queue!: string;
  state!: string;
  attemptsMade!: number;
  @ApiProperty({ nullable: true }) processedOn!: number | null;
  @ApiProperty({ nullable: true }) finishedOn!: number | null;
  timestamp!: number;
  @ApiProperty({
    nullable: true,
    description:
      'The failure reason recorded by BullMQ. Present for failed jobs; this is a stack/message the handler produced, not user data.',
  })
  failedReason!: string | null;
  @ApiProperty({
    required: false,
    description:
      'The raw job payload. Present ONLY for callers holding `readPayload QueueJob` (platform engineers). Absent — not masked — for everyone else.',
  })
  payload?: unknown;

  constructor(value: QueueJobResponseDto) {
    Object.assign(this, value);
  }
}

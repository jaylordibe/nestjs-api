import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { IsUtcIsoString } from '../../decorators/is-utc-iso-string.decorator';

// Base shape every queued job payload extends.
//
// Payload rules (enforced by the processor, which validates against the
// concrete DTO before the handler ever sees the data):
//   - Carry stable IDENTIFIERS and execution metadata, never whole entities.
//     A serialized entity is stale the moment it lands in Redis; the handler
//     reloads current state from the database instead.
//   - No secrets, no personal data. Redis retains finalized jobs and the
//     lifecycle logs quote payload metadata.
//   - Timestamps are UTC ISO 8601 strings, same as every other datetime that
//     crosses this API's boundary.
//
// Deliberately no `entityId` here: jobs that act on a domain row add their own,
// typed and named for what it actually points at (`bookingId`, `userId`), which
// reads better than a generic column and lets an entity-less job (the queue
// heartbeat) extend this without carrying a field it has to leave blank.
export class BaseJobPayloadDto {
  // Shape version of THIS payload, checked against the job registry before
  // execution. A mismatch fails permanently instead of retrying — retrying
  // cannot turn an unreadable payload into a readable one.
  @IsInt()
  @Min(1)
  payloadVersion!: number;

  // Ties the job's logs back to the HTTP request that enqueued it. The
  // processor seeds it into CLS as the request ID, so a worker's log lines
  // carry the same identifier as the request that caused them. Free-form
  // because `X-Request-Id` is client-supplied and need not be a UUID.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  correlationId?: string;

  // The ABSOLUTE instant the job was scheduled for. BullMQ only stores a
  // relative delay, which tells a worker nothing about whether the schedule it
  // was created from still stands — so the absolute value rides in the payload
  // and the handler compares it against current domain state.
  @IsOptional()
  @IsUtcIsoString()
  scheduledAt?: string;

  // Revision of the domain's authoritative schedule. Rescheduling bumps it; a
  // handler that finds a newer version on the entity knows this job is stale
  // and skips instead of acting on a superseded plan.
  @IsOptional()
  @IsInt()
  @Min(0)
  scheduleVersion?: number;
}

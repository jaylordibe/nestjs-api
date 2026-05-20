import { ErrorCode } from './error-code.enum';

// The structured payload every `Errors.*` factory passes as the first
// argument to its `HttpException` constructor. The filter reads these
// fields back via `exception.getResponse()` to populate the response
// envelope. Anything not present here gets a sensible default
// (status-derived `errorCode`, `details: null`).
export interface AppExceptionPayload {
  errorCode: ErrorCode;
  message: string;
  details?: unknown;
}

// The exact shape the API returns on every error response. Public
// contract — see src/common/errors/README.md for the consumer-facing
// documentation. Keys are grouped by category for readability:
// status info first, then human/machine identifiers, then context.
export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  errorCode: ErrorCode;
  message: string;
  details: unknown;
  path: string;
  timestamp: string;
  requestId?: string;
}

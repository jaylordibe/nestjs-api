# API/event contract: [Operation]

- **Related plan/ticket:**
- **Owner:**
- **Consumers:** web | mobile | external | worker
- **Status:** Proposed | Active | Deprecated

## Endpoint or event

- Type: REST | Webhook | Event | Job
- Route/topic:
- Method/name:
- Access decorator:
- Permission/subject/ownership:
- PLATFORM/BUSINESS scope:
- Throttle:
- Idempotency key:
- Audit action:

## Request DTO

| Field | Type | Required/null | Validation/normalization | Authoritative source |
|---|---|---|---|---|
| | | | | |

Authoritative money, price, totals, role, tenant, provider, owner, permission,
entitlement, and approval fields must be server-derived.

## Response DTO

- DTO class:
- Constructor input:
- Sensitive `@Exclude` fields:
- Swagger-hidden fields:

```json
{}
```

Never return a raw Prisma row.

## Errors

Envelope:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "errorCode": "STABLE_MACHINE_CODE",
  "message": "Safe message",
  "details": null,
  "path": "/api/example",
  "timestamp": "UTC timestamp",
  "requestId": "correlation id"
}
```

| HTTP | `Errors.*` factory/errorCode | Condition | Enumeration behavior | Retryable |
|---|---|---|---|---|
| | | | | |

Clients program against `errorCode`, not message.

## Pagination/filter/sort

- Uses `MetaQueryDto`:
- maximum `perPage`:
- stable sort and tie-breaker:
- search fields:
- scoped query:
- no unpaginated path:

## Swagger

- `@ApiTags`:
- `@ApiBearerAuth`:
- paginated response decorator:
- non-paginated response decorator:
- mapped type import:
- acknowledgement/redirect documentation:

## Compatibility and rollout

- existing consumers:
- required/optional/null changes:
- enum/error changes:
- deployment order:
- mixed-version behavior:
- deprecation:
- cross-repo blocker:

## Contract tests

| Scenario | Request/actor | Expected status/errorCode/body |
|---|---|---|
| | | |

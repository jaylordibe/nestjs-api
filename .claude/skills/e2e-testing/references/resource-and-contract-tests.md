# Resource and contract e2e checklist

The one checklist for a resource's e2e coverage. Map tests to the accepted
behavior and its risk — do not blindly add every case to every resource.

- create; find paginated; find by ID; update; delete;
- unauthenticated access; insufficient permission;
- owner and tenant visibility, including 404 versus 403;
- validation failures and unknown fields;
- pagination metadata and deterministic order;
- search, filter and sort, including invalid input;
- not-found behavior;
- stable error envelope and `errorCode`;
- response DTO serialization and secret exclusion;
- audit and lifecycle columns through direct DB assertions;
- the chosen delete lifecycle (hard, soft, or erasure);
- uniqueness and conflict, including live-row partial uniqueness and re-use
  after delete;
- transaction and concurrency behavior;
- relation serialization;
- Swagger/consumer-sensitive shape where testable.

## Shared principals

- seed the RBAC catalog after truncation;
- create platform admin/support/regular users through helpers;
- create workspace memberships through established helpers;
- use register/login helpers only when the auth flow itself is under test.

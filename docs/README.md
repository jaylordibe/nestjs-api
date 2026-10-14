# Deployment

The application is **cloud-provider neutral**. It depends on generic
capabilities — an HTTP runtime, PostgreSQL, a Redis-compatible backend, object
storage, runtime-injected secrets, a worker runtime, stdout logging and HTTP
health checks — and on nothing that ties it to one vendor.

Three commands deploy it anywhere:

| Runtime | Command | `QUEUE_WORKER_ENABLED` |
|---|---|---|
| API | `node dist/main.js` | `false` |
| Worker | `node dist/worker.js` | `true` |
| Migration | the `migrate` image — `yarn prisma:deploy && yarn rbac:sync` | n/a |

| Document | What it is |
|---|---|
| **[`deployment/`](./deployment/README.md)** | **The contract.** Runtime commands, container, database, Redis, storage, secrets, health and environment — provider-neutral, with AWS / Google Cloud / Azure / Kubernetes / Compose shown only as example mappings. **Start here.** |
| [`operations.md`](./operations.md) | Which operational controls are actually enforced versus only scaffolded. |

> CRUD / resource scaffolding lives in [`resource-pattern.md`](./resource-pattern.md),
> not here — this directory is deployment-only.

## This repository publishes; a deployer deploys

`.github/workflows/publish-image.yml` builds, scans and publishes the runtime and
`migrate` images to GHCR on every push to `main` or `staging`, with a
build-provenance attestation, once the repository variable `PUBLISH_ENABLED=true`
is set. It holds no server credential and deploys nothing.

**One server, several projects:** [jaylordibe/cicd](https://github.com/jaylordibe/cicd)
deploys these images to a single VM behind Caddy. Its `nestjs-api` template is the
production shape this directory used to carry as Compose files:
- the API with its in-process queue worker;
- its own PostgreSQL and Redis (AOF) on a private network;
- the `migrate` image run before every rollout;
- Caddy as the edge, including a Cloudflare-only mode (Origin Certificate, Authenticated Origin Pulls, Cloudflare's ranges);
- nightly and pre-deploy database dumps.

Its README covers the setup, adding an SPA next to the API, and the rest of the runbook.

What that single-server shape assumes, wherever you run it:

- **One process runs both API and worker** (`QUEUE_WORKER_ENABLED=true`). That is
  correct on one box with no autoscaler, and wrong the moment the API scales
  horizontally: every instance would then consume jobs and race to reconcile the
  same recurring schedules. Split the worker out first (`deployment/README.md`).
- **`TRUST_PROXY` is the edge's one fixed address.** Behind Cloudflare, the edge,
  not the application, turns `CF-Connecting-IP` into the client address.
- **Swagger is protected by the edge** on staging (basic auth on the one
  `/api/docs` subtree) and turned off by the application in production.

**Before you run any of this against real data, read
[`operations.md`](./operations.md).** It is an honest inventory of which operational
controls this template enforces and which it only gives you a place to put —
backups, restore verification, RPO/RTO, secret rotation, retention, queue
backpressure, incident response, and rollback.

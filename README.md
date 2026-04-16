# NestJS API Template

Opinionated starter for building a JSON API with **NestJS 11 + Prisma 7 + PostgreSQL**. Use it as a GitHub template — click *Use this template*, clone, set `SERVICE_NAME`, and start adding feature modules.

## What's included

- NestJS 11 (TypeScript, Express) with global `ValidationPipe`, `ClassSerializerInterceptor`, and a normalized exception filter
- Prisma 7 with the `@prisma/adapter-pg` driver adapter and a `@Global()` `PrismaService` (`extends PrismaClient`, lifecycle-aware)
- JWT auth with role-based access control (`ADMIN`, `USER`) and a `@CurrentUser()` decorator
- Joi-validated, dot-path `ConfigService` access (`configService.getOrThrow('jwt.secret')`)
- **Security headers** via `helmet` (OWASP defaults applied to every response)
- **Rate limiting** via `@nestjs/throttler` (global `APP_GUARD` from env, stricter per-route limits on `POST /auth/login` and `POST /auth/register` to slow brute force)
- **Health checks** via `@nestjs/terminus` — `GET /api/health/liveness` (process-only) and `GET /api/health/readiness` (DB ping). Drop-in for k8s/load-balancer probes.
- Dockerized Postgres 18 (pinned, glibc-based) and Redis 8 (pinned, password-required, AOF persistence) for local dev, plus a 3-stage production `Dockerfile` (non-root `app` user, `tini` entrypoint)
- ESLint (`typescript-eslint` recommended-type-checked) + Prettier preconfigured
- **Real e2e tests** against a Postgres test DB (no mocks) — auth + users + health coverage out of the box, plus a `truncateAll` helper for isolation
- **GitHub Actions CI** that runs lint + build + unit + e2e tests on every PR (real Postgres service container)

All endpoints are mounted under `/api`.

## First-time setup

Requires Node 22+ (LTS — Prisma 7 needs ≥22; CI and Docker run Node 24), Yarn, and Docker.

```bash
# 1. start Postgres
docker compose up -d

# 2. configure env
cp .env.example .env
# edit .env — at minimum set JWT_SECRET; optionally rename SERVICE_NAME

# 3. install + generate Prisma client + run initial migration
yarn install
yarn prisma:generate
yarn prisma:migrate --name init

# 4. run the API in watch mode
yarn start:dev
```

The default `.env.example` matches the compose file, so the only value you really need to change is `JWT_SECRET`. `SERVICE_NAME` drives the DB name and the docker container name — change it once and the rest follows automatically.

## Common commands

| Command | What it does |
| --- | --- |
| `yarn start:dev` | Watch-mode dev server |
| `yarn start:prod` | Run the compiled build |
| `yarn build` | `nest build` to `dist/` |
| `yarn lint` | ESLint `--fix` over `src` and `test` |
| `yarn format` | Prettier write |
| `yarn test` | Jest unit tests (`*.spec.ts`) |
| `yarn test:e2e` | Jest e2e (`test/jest-e2e.json`) |
| `yarn prisma:generate` | Regenerate `@prisma/client` after schema edits |
| `yarn prisma:migrate` | `prisma migrate dev` (interactive) |
| `yarn prisma:deploy` | `prisma migrate deploy` (production, non-interactive) |
| `yarn prisma:studio` | DB browser |
| `docker compose up -d` / `down` | Start / stop Postgres (add `-v` to wipe data) |

## Endpoints

All under `/api`:

- `POST /auth/register`, `POST /auth/login`, `GET /auth/me` — auth + "who am I?"
- `GET|POST /users`, `GET|PATCH|DELETE /users/:id` — `ADMIN` only
- `GET /health/liveness`, `GET /health/readiness` — process / DB checks for probes

## Project layout

```
src/
  main.ts              # bootstrap: prefix /api, ValidationPipe, ClassSerializerInterceptor, AllExceptionsFilter, CORS
  app.module.ts        # ConfigModule (global, Joi-validated) + PrismaModule + feature modules
  config/              # configuration.ts (typed factory) + env.validation.ts (Joi schema)
  prisma/              # @Global() PrismaModule + PrismaService
  common/
    decorators/        # Roles, CurrentUser
    guards/            # RolesGuard
    filters/           # AllExceptionsFilter
  modules/
    auth/              # AuthService, AuthController, JwtStrategy, JwtAuthGuard, DTOs
    users/             # UsersService, controller, DTOs
    health/            # GET /api/health
prisma/schema.prisma   # User + Role enum, PostgreSQL datasource
```

See `CLAUDE.md` for the full conventions reference (validation, password redaction, JWT payload shape, role guards, Prisma error mapping, config access, etc.).

## Production Docker build

```bash
docker build -t my-api .
docker run --rm -p 3000:3000 --env-file .env my-api
```

The image runs `node dist/main.js` as a non-root user. Migrations are intentionally **not** run on container start — invoke `prisma migrate deploy` from an init container or deploy hook.

## License

UNLICENSED — adjust `package.json` and add a `LICENSE` file when you spin up a new project from this template.

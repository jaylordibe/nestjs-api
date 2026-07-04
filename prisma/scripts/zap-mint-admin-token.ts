/**
 * CI-only helper for the OWASP ZAP authenticated scan
 * (.github/workflows/security-dast.yml). Runs against the EPHEMERAL scan
 * database only — never staging/prod.
 *
 * Creates (or reuses) a throwaway admin user, then prints a bearer token for
 * it to stdout so the workflow can inject it via ZAP's replacer rule.
 *
 * The token is minted directly rather than via POST /auth/login on purpose:
 * login is guarded by lockout (and, in derived services, bot/origin
 * protections) that are brittle to satisfy headlessly. We control JWT_SECRET
 * in CI, so we sign a token that JwtStrategy will accept.
 *
 * Token contract MUST match src/modules/auth/auth.module.ts + jwt.strategy.ts:
 *   - secret   = JWT_SECRET
 *   - issuer   = audience = SERVICE_NAME
 *   - payload  = { sub, email, role }; NO `purpose` claim (rejected as non-auth)
 *   - NO `jti`: JwtStrategy revokes by jti, so a jti-less token survives even
 *     if the scan happens to hit POST /auth/logout. Without this the first
 *     logout request would blocklist the token and 401 the rest of the scan.
 *
 * stdout = the raw token ONLY (the workflow captures it); all logs go to stderr.
 */
import 'dotenv/config';
import { expand } from 'dotenv-expand';
import * as dotenv from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as jwt from 'jsonwebtoken';

// Load .env (with ${VAR} expansion) before touching process.env, matching
// prisma/seed.ts. In CI the vars are already in the environment, so this is a
// harmless no-op there.
expand(dotenv.config({ override: false }));

async function main(): Promise<void> {
  const serviceName = process.env.SERVICE_NAME;
  const secret = process.env.JWT_SECRET;
  if (!serviceName || !secret) {
    throw new Error('SERVICE_NAME and JWT_SECRET must be set');
  }

  // Prisma 7 driver-adapter setup (schema.prisma has no url) — same as seed.ts.
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });
  try {
    const email = 'zap-scanner@scan.invalid';
    // email has no unique constraint on the soft-delete model, so find-or-create
    // rather than upsert. Idempotent across re-runs against the same DB.
    const existing = await prisma.user.findFirst({ where: { email } });
    const admin =
      existing ??
      (await prisma.user.create({
        data: {
          firstName: 'ZAP',
          lastName: 'Scanner',
          email,
          // Auth is via the minted token, not login — password is never used,
          // but the column is NOT NULL. Placeholder, not a valid credential.
          password: 'zap-scan-no-login',
          role: 'admin',
          isActive: true,
          // Verified so email-gated endpoints are in scope for the scan.
          emailVerifiedAt: new Date(),
        },
      }));

    const token = jwt.sign(
      { sub: admin.id, email: admin.email, role: admin.role },
      secret,
      { issuer: serviceName, audience: serviceName, expiresIn: '6h' },
    );

    process.stderr.write(`[zap] minted admin token for ${admin.id}\n`);
    process.stdout.write(token);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(`[zap] mint failed: ${String(error)}\n`);
  process.exit(1);
});

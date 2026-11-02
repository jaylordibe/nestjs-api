import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { errors, type Adapter, type AdapterPayload } from 'oidc-provider';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * The models whose id IS the credential handed to the client: whoever holds
 * the id can use it. Stored under its SHA-256 and without the `jti` the
 * library keeps in the payload, so the table never holds a usable code or
 * token — the convention `refresh_tokens.token_hash` follows.
 */
const CREDENTIAL_MODELS = new Set([
  'AuthorizationCode',
  'AccessToken',
  'RefreshToken',
]);

const sha256 = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * oidc-provider's storage adapter over the `oauth_payloads` table, in the
 * library's documented adapter shape (one instance per model name).
 */
export class OAuthPayloadAdapter implements Adapter {
  private readonly isCredential: boolean;

  constructor(
    private readonly model: string,
    private readonly prisma: PrismaService,
  ) {
    this.isCredential = CREDENTIAL_MODELS.has(model);
  }

  private key(id: string): string {
    return this.isCredential ? sha256(id) : id;
  }

  async upsert(
    id: string,
    payload: AdapterPayload,
    expiresIn?: number,
  ): Promise<void> {
    const stored: AdapterPayload = { ...payload };
    if (this.isCredential) delete stored.jti;
    const data = {
      payload: stored as Prisma.InputJsonValue,
      grantId: payload.grantId ?? null,
      userCode: payload.userCode ?? null,
      uid: payload.uid ?? null,
      expiresAt: expiresIn ? new Date(Date.now() + expiresIn * 1000) : null,
    };
    await this.prisma.oAuthPayload.upsert({
      where: { model_id: { model: this.model, id: this.key(id) } },
      create: { model: this.model, id: this.key(id), ...data },
      update: data,
    });
  }

  async find(id: string): Promise<AdapterPayload | undefined> {
    const row = await this.prisma.oAuthPayload.findUnique({
      where: { model_id: { model: this.model, id: this.key(id) } },
    });
    if (!row) return undefined;
    return this.toPayload(row, this.isCredential ? id : undefined);
  }

  async findByUid(uid: string): Promise<AdapterPayload | undefined> {
    const row = await this.prisma.oAuthPayload.findFirst({
      where: { model: this.model, uid },
    });
    return row ? this.toPayload(row) : undefined;
  }

  async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
    const row = await this.prisma.oAuthPayload.findFirst({
      where: { model: this.model, userCode },
    });
    return row ? this.toPayload(row) : undefined;
  }

  // Atomic: of two concurrent redemptions of one code or refresh token, only
  // the one that flips `consumed_at` proceeds. The provider calls this before
  // it issues anything, so throwing here aborts the losing request with
  // `invalid_grant` — and does not revoke the grant, so a client's network
  // retry does not end the user's session.
  async consume(id: string): Promise<void> {
    const { count } = await this.prisma.oAuthPayload.updateMany({
      where: { model: this.model, id: this.key(id), consumedAt: null },
      data: { consumedAt: new Date() },
    });
    if (count === 0) {
      throw new errors.InvalidGrant('grant request is invalid');
    }
  }

  async destroy(id: string): Promise<void> {
    await this.prisma.oAuthPayload.deleteMany({
      where: { model: this.model, id: this.key(id) },
    });
  }

  // Grants are revoked across every model (codes, access and refresh tokens).
  async revokeByGrantId(grantId: string): Promise<void> {
    await this.prisma.oAuthPayload.deleteMany({ where: { grantId } });
  }

  // An expired row reads as absent, so nothing depends on the retention sweep
  // having run.
  private toPayload(
    row: {
      payload: Prisma.JsonValue;
      expiresAt: Date | null;
      consumedAt: Date | null;
    },
    jti?: string,
  ): AdapterPayload | undefined {
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now())
      return undefined;
    const payload = { ...(row.payload as AdapterPayload) };
    if (jti !== undefined) payload.jti = jti;
    if (row.consumedAt) {
      payload.consumed = Math.floor(row.consumedAt.getTime() / 1000);
    }
    return payload;
  }
}

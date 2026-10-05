import type { ConfigService } from '@nestjs/config';
import type { RedisService } from '../redis/redis.service';
import { DestinationSendLimitService } from './destination-send-limit.service';
import { SEND_LIMITS, SendPurpose } from './send-limit.config';

// An in-memory stand-in for the Redis calls the service makes. The real
// counter is exercised end to end by the e2e specs; this pins the service's
// own decisions: the limit, the key it builds, and the release.
function fakeRedis() {
  const counters = new Map<string, number>();
  const expiries = new Map<string, number>();
  const client = {
    multi: () => {
      const steps: Array<() => [null, unknown]> = [];
      const transaction = {
        incr: (key: string) => {
          steps.push(() => {
            const next = (counters.get(key) ?? 0) + 1;
            counters.set(key, next);
            return [null, next];
          });
          return transaction;
        },
        expire: (key: string, seconds: number, mode: string) => {
          steps.push(() => {
            if (mode !== 'NX' || !expiries.has(key)) expiries.set(key, seconds);
            return [null, 1];
          });
          return transaction;
        },
        exec: () => Promise.resolve(steps.map((step) => step())),
      };
      return transaction;
    },
    get: (key: string) =>
      Promise.resolve(counters.has(key) ? String(counters.get(key)) : null),
    // The release script: decrement only a key that still exists.
    eval: (_script: string, _keyCount: number, key: string) => {
      if (!counters.has(key)) return Promise.resolve(0);
      counters.set(key, counters.get(key)! - 1);
      return Promise.resolve(counters.get(key));
    },
  };
  return { redis: { client } as unknown as RedisService, counters, expiries };
}

describe('DestinationSendLimitService', () => {
  const configService = {
    getOrThrow: () => 'a-jwt-secret-long-enough-for-the-test',
  } as unknown as ConfigService;

  const create = () => {
    const fake = fakeRedis();
    return {
      ...fake,
      service: new DestinationSendLimitService(fake.redis, configService),
    };
  };

  it('allows the purpose limit, then refuses', async () => {
    const { service } = create();
    const { limit } = SEND_LIMITS[SendPurpose.PASSWORD_RESET];

    for (let send = 0; send < limit; send++) {
      await expect(
        service.reserve(SendPurpose.PASSWORD_RESET, 'victim@example.com'),
      ).resolves.not.toBeNull();
    }
    await expect(
      service.reserve(SendPurpose.PASSWORD_RESET, 'victim@example.com'),
    ).resolves.toBeNull();
  });

  // One purpose filling up must never block another — above all, nothing may
  // use up a destination's password-reset budget.
  it('keeps each purpose on its own budget', async () => {
    const { service } = create();
    const { limit } = SEND_LIMITS[SendPurpose.EMAIL_VERIFICATION];
    for (let send = 0; send <= limit; send++) {
      await service.reserve(SendPurpose.EMAIL_VERIFICATION, 'a@example.com');
    }

    await expect(
      service.reserve(SendPurpose.PASSWORD_RESET, 'a@example.com'),
    ).resolves.not.toBeNull();
  });

  it('keeps each destination on its own budget', async () => {
    const { service } = create();
    const { limit } = SEND_LIMITS[SendPurpose.PHONE_VERIFICATION];
    for (let send = 0; send <= limit; send++) {
      await service.reserve(SendPurpose.PHONE_VERIFICATION, '+15005550006');
    }

    await expect(
      service.reserve(SendPurpose.PHONE_VERIFICATION, '+15005550007'),
    ).resolves.not.toBeNull();
  });

  it('keys on an HMAC, never on the destination itself', async () => {
    const { service, counters } = create();

    await service.reserve(SendPurpose.PHONE_VERIFICATION, '+15005550006');
    await service.reserve(SendPurpose.EMAIL_VERIFICATION, 'victim@example.com');

    for (const key of counters.keys()) {
      expect(key).toMatch(/^send-limit:[a-z-]+:[0-9a-f]{64}$/);
      expect(key).not.toContain('@');
      expect(key).not.toContain('5005550006');
    }
  });

  it('starts the window at the first send and sets the purpose window', async () => {
    const { service, expiries } = create();

    await service.reserve(SendPurpose.PHONE_VERIFICATION, '+15005550006');

    expect([...expiries.values()]).toEqual([
      SEND_LIMITS[SendPurpose.PHONE_VERIFICATION].windowSeconds,
    ]);
  });

  // A provider outage and its retries must not use up a real person's budget.
  it('gives the budget back when the send fails', async () => {
    const { service } = create();
    const { limit } = SEND_LIMITS[SendPurpose.PHONE_VERIFICATION];
    for (let attempt = 0; attempt < limit + 2; attempt++) {
      await expect(
        service.sendWithinLimit(
          SendPurpose.PHONE_VERIFICATION,
          '+15005550006',
          () => Promise.reject(new Error('provider down')),
        ),
      ).rejects.toThrow('provider down');
    }

    await expect(
      service.sendWithinLimit(
        SendPurpose.PHONE_VERIFICATION,
        '+15005550006',
        () => Promise.resolve(),
      ),
    ).resolves.toBe(true);
  });

  // A bare DECR on an expired key would recreate it at -1 with no expiry.
  it('does not recreate a counter that expired before the send failed', async () => {
    const { service, counters } = create();
    const reservation = await service.reserve(
      SendPurpose.PHONE_VERIFICATION,
      '+15005550006',
    );
    counters.clear();

    await expect(
      service.sendReserved(reservation!, () =>
        Promise.reject(new Error('provider down')),
      ),
    ).rejects.toThrow('provider down');

    expect(counters.size).toBe(0);
  });

  it('reports budget without counting a send', async () => {
    const { service } = create();
    const { limit } = SEND_LIMITS[SendPurpose.WORKSPACE_INVITATION];
    for (let send = 0; send < limit - 1; send++) {
      await service.reserve(SendPurpose.WORKSPACE_INVITATION, 'a@example.com');
    }

    await expect(
      service.hasBudget(SendPurpose.WORKSPACE_INVITATION, 'a@example.com'),
    ).resolves.toBe(true);
    await expect(
      service.hasBudget(SendPurpose.WORKSPACE_INVITATION, 'a@example.com'),
    ).resolves.toBe(true);
    await service.reserve(SendPurpose.WORKSPACE_INVITATION, 'a@example.com');
    await expect(
      service.hasBudget(SendPurpose.WORKSPACE_INVITATION, 'a@example.com'),
    ).resolves.toBe(false);
  });

  it('never runs the send when the destination is over its limit', async () => {
    const { service } = create();
    const { limit } = SEND_LIMITS[SendPurpose.PASSWORD_RESET];
    const send = jest.fn(() => Promise.resolve());
    for (let attempt = 0; attempt <= limit; attempt++) {
      await service.sendWithinLimit(
        SendPurpose.PASSWORD_RESET,
        'victim@example.com',
        send,
      );
    }

    expect(send).toHaveBeenCalledTimes(limit);
  });

  it('propagates a Redis failure rather than deciding for the caller', async () => {
    const { service, redis } = create();
    (redis.client as unknown as { multi: () => unknown }).multi = () => ({
      incr: function () {
        return this;
      },
      expire: function () {
        return this;
      },
      exec: () => Promise.reject(new Error('Connection is closed.')),
    });

    const send = jest.fn(() => Promise.resolve());
    await expect(
      service.reserve(SendPurpose.PHONE_VERIFICATION, '+15005550006'),
    ).rejects.toThrow('Connection is closed.');
    // An email job must throw (and be retried), never skip or send blind.
    await expect(
      service.sendWithinLimit(
        SendPurpose.PASSWORD_RESET,
        'victim@example.com',
        send,
      ),
    ).rejects.toThrow('Connection is closed.');
    expect(send).not.toHaveBeenCalled();
  });

  // A counter whose expiry failed would never reset: the destination would be
  // refused for good.
  it('fails when the expiry cannot be set', async () => {
    const { service, redis } = create();
    (redis.client as unknown as { multi: () => unknown }).multi = () => ({
      incr: function () {
        return this;
      },
      expire: function () {
        return this;
      },
      exec: () =>
        Promise.resolve([
          [null, 1],
          [new Error('ERR syntax error'), null],
        ]),
    });

    await expect(
      service.reserve(SendPurpose.PHONE_VERIFICATION, '+15005550006'),
    ).rejects.toThrow('ERR syntax error');
  });
});

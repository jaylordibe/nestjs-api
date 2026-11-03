import type { ConfigService } from '@nestjs/config';
import { AzureFileStorageAdapter } from './azure-file-storage.adapter';

// The real adapter and the real SAS signer; only the Azure AD round trip that
// mints a user delegation key is replaced.
function buildAdapter(): {
  adapter: AzureFileStorageAdapter;
  getUserDelegationKey: jest.Mock;
} {
  const configuration: Record<string, unknown> = {
    'storage.azure.accountName': 'fixtureaccount',
    'storage.azure.container': 'files',
    'storage.requestTimeoutMs': 15_000,
  };
  const configService = {
    get: (path: string) => configuration[path],
    getOrThrow: (path: string) => configuration[path],
  } as unknown as ConfigService;
  const adapter = new AzureFileStorageAdapter(configService);
  const getUserDelegationKey = jest.fn(
    // Shaped like the SDK's UserDelegationKey; the type itself stays inside
    // the adapter, the one file allowed to import the Azure SDK.
    (startsOn: Date, expiresOn: Date): Promise<Record<string, unknown>> =>
      Promise.resolve({
        signedObjectId: 'object-id',
        signedTenantId: 'tenant-id',
        signedStartsOn: startsOn,
        signedExpiresOn: expiresOn,
        signedService: 'b',
        signedVersion: '2025-01-05',
        value: Buffer.from('fixture-delegation-key').toString('base64'),
      }),
  );
  (
    adapter as unknown as {
      blobServiceClient: { getUserDelegationKey: jest.Mock };
    }
  ).blobServiceClient.getUserDelegationKey = getUserDelegationKey;
  return { adapter, getUserDelegationKey };
}

describe('AzureFileStorageAdapter signed URLs', () => {
  it('signs a page of URLs with one delegation key fetch', async () => {
    const { adapter, getUserDelegationKey } = buildAdapter();

    const urls = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        adapter.createSignedReadUrl(`files/profile-images/${index}.png`, 300),
      ),
    );

    expect(getUserDelegationKey).toHaveBeenCalledTimes(1);
    expect(new Set(urls).size).toBe(25);
    for (const url of urls) {
      expect(url).toContain('sp=r');
      expect(url).toContain('skoid=object-id');
    }
  });

  it('fetches again after a failed fetch instead of caching the failure', async () => {
    const { adapter, getUserDelegationKey } = buildAdapter();
    getUserDelegationKey.mockRejectedValueOnce(new Error('AAD unavailable'));

    await expect(
      adapter.createSignedReadUrl('files/a.png', 300),
    ).rejects.toThrow('AAD unavailable');
    await expect(
      adapter.createSignedReadUrl('files/a.png', 300),
    ).resolves.toContain('sig=');
    expect(getUserDelegationKey).toHaveBeenCalledTimes(2);
  });

  it('renews the key once it would not outlive the URL being signed', async () => {
    const { adapter, getUserDelegationKey } = buildAdapter();
    jest.useFakeTimers({ now: new Date('2026-11-03T00:00:00Z') });
    try {
      await adapter.createSignedReadUrl('files/a.png', 3600);
      // 90 minutes later the 2-hour key ends in 30 minutes: too soon for a
      // one-hour URL.
      jest.setSystemTime(new Date('2026-11-03T01:30:00Z'));
      await adapter.createSignedReadUrl('files/a.png', 3600);
    } finally {
      jest.useRealTimers();
    }
    expect(getUserDelegationKey).toHaveBeenCalledTimes(2);
  });
});

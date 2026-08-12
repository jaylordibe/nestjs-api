import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DefaultAzureCredential } from '@azure/identity';
import {
  BlobSASPermissions,
  BlobServiceClient,
  SASProtocol,
  generateBlobSASQueryParameters,
} from '@azure/storage-blob';
import * as path from 'path';
import { formatErrorMessage } from '../../util/error-message.util';
import { buildObjectName } from '../../util/storage-object-name.util';
import {
  FileStorageAdapter,
  StoredObject,
} from './file-storage-adapter.interface';

// Azure Blob Storage. Selected with STORAGE_PROVIDER=azure.
//
// This file is the ONLY place in the application that imports an Azure SDK, and
// it is loaded only when this provider is selected.
//
// CREDENTIALS are `DefaultAzureCredential`: a managed identity on Container
// Apps / App Service / AKS workload identity, an Azure CLI login locally. There
// is deliberately no configuration key for an account key or a connection
// string — both are long-lived shared secrets that grant full control of the
// storage account, and both are avoidable on every supported host.
//
// SIGNED URLS are USER DELEGATION SAS tokens, signed with a key obtained from
// Azure AD rather than the account key. That is what keeps this keyless: the
// SAS inherits the identity's own permissions and cannot outlive the delegation
// key. The identity needs `Storage Blob Data Contributor` on the container.
// Tolerance for clock drift between this process and the storage service when
// stamping a SAS start time. Five minutes is the conventional allowance and
// costs nothing: the grant's EXPIRY is still measured from now.
const CLOCK_SKEW_ALLOWANCE_MILLISECONDS = 5 * 60 * 1000;

@Injectable()
export class AzureFileStorageAdapter implements FileStorageAdapter {
  readonly providerName = 'azure';

  private readonly logger = new Logger(AzureFileStorageAdapter.name);
  private readonly blobServiceClient: BlobServiceClient;
  private readonly accountName: string;
  private readonly containerName: string;
  private readonly publicUrlBase: string | null;

  constructor(configService: ConfigService) {
    this.accountName = configService.getOrThrow<string>(
      'storage.azure.accountName',
    );
    this.containerName = configService.getOrThrow<string>(
      'storage.azure.container',
    );
    this.publicUrlBase =
      configService.get<string>('storage.publicUrlBase') ?? null;

    this.blobServiceClient = new BlobServiceClient(
      `https://${this.accountName}.blob.core.windows.net`,
      new DefaultAzureCredential(),
      {
        // Bounds each attempt. Unset, the SDK waits indefinitely on a stalled
        // connection and the caller's database connection stays checked out.
        retryOptions: {
          tryTimeoutInMs: configService.getOrThrow<number>(
            'storage.requestTimeoutMs',
          ),
        },
      },
    );
  }

  private blobClient(storageKey: string) {
    return this.blobServiceClient
      .getContainerClient(this.containerName)
      .getBlockBlobClient(storageKey);
  }

  async save(
    file: Express.Multer.File,
    subdirectory: string,
  ): Promise<StoredObject> {
    const storageKey = buildObjectName(
      subdirectory,
      path.extname(file.originalname).toLowerCase(),
    );
    await this.blobClient(storageKey).uploadData(file.buffer, {
      blobHTTPHeaders: {
        blobContentType: file.mimetype,
        // Immutable objects (fresh UUID per write), so a fronting CDN can keep
        // them indefinitely. Caching, not permission — the container's own
        // access level decides readability.
        blobCacheControl: 'public, max-age=31536000, immutable',
      },
    });
    return { storageKey, publicUrl: this.resolvePublicUrl(storageKey) };
  }

  async delete(storageKey: string): Promise<void> {
    try {
      await this.blobClient(storageKey).deleteIfExists();
    } catch (error) {
      this.logger.warn(
        `Failed to delete ${this.containerName}/${storageKey}: ${formatErrorMessage(error)}`,
      );
    }
  }

  async createSignedReadUrl(
    storageKey: string,
    ttlSeconds: number,
  ): Promise<string> {
    // Back-dated, deliberately. A SAS whose `st` is even slightly ahead of the
    // storage service's clock is rejected outright ("Signature not valid in the
    // specified time frame") — and at the 30s TTL floor a few seconds of skew
    // can miss the window entirely. Expiry is still measured from NOW, so the
    // grant is never longer than the caller asked for.
    const startsOn = new Date(Date.now() - CLOCK_SKEW_ALLOWANCE_MILLISECONDS);
    const expiresOn = new Date(Date.now() + ttlSeconds * 1000);

    // The delegation key is fetched per call rather than cached. It is an
    // Azure AD round trip, but caching one would mean holding a signing
    // credential in memory past the lifetime of the URLs it was fetched for —
    // and signed reads are not on a hot path.
    const userDelegationKey = await this.blobServiceClient.getUserDelegationKey(
      startsOn,
      expiresOn,
    );

    const sasQueryParameters = generateBlobSASQueryParameters(
      {
        containerName: this.containerName,
        blobName: storageKey,
        // Read only. Never `racwd` — a signed URL handed to a client must not
        // be able to overwrite or delete the object it points at.
        permissions: BlobSASPermissions.parse('r'),
        startsOn,
        expiresOn,
        protocol: SASProtocol.Https,
      },
      userDelegationKey,
      this.accountName,
    );

    return `${this.blobClient(storageKey).url}?${sasQueryParameters.toString()}`;
  }

  resolvePublicUrl(storageKey: string): string | null {
    return this.publicUrlBase ? `${this.publicUrlBase}/${storageKey}` : null;
  }
}

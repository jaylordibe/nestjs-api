import { Module } from '@nestjs/common';
import { SignedReadUrlCacheService } from './signed-read-url-cache.service';

// Separate from the global `FileStorageModule`, which is built without Redis
// where only the storage backend is under test.
@Module({
  providers: [SignedReadUrlCacheService],
  exports: [SignedReadUrlCacheService],
})
export class SignedReadUrlCacheModule {}

import { Module } from '@nestjs/common';
import { QueueAdminController } from './queue-admin.controller';
import { QueueAdminService } from './queue-admin.service';

// No `imports`: QueueModule, AuditModule and the authorization module are all
// `@Global()`.
@Module({
  controllers: [QueueAdminController],
  providers: [QueueAdminService],
})
export class QueueAdminModule {}

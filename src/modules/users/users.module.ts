import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WorkspacesModule } from '../workspaces/workspaces.module';
import {
  EmailVerificationJobHandler,
  PasswordChangedNoticeJobHandler,
  PasswordResetJobHandler,
} from './jobs/user-email.handlers';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // `WorkspacesModule` is imported directly, not through `forwardRef`: it
  // imports nothing, so there is no cycle to break. Reaching for `forwardRef`
  // "just in case" hides a real cycle the day one appears.
  imports: [forwardRef(() => AuthModule), WorkspacesModule],
  controllers: [UsersController],
  providers: [
    UsersService,
    EmailVerificationJobHandler,
    PasswordResetJobHandler,
    PasswordChangedNoticeJobHandler,
  ],
  exports: [UsersService],
})
export class UsersModule {}

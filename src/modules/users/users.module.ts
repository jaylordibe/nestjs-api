import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { BusinessesModule } from '../businesses/businesses.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  // `BusinessesModule` is imported directly, not through `forwardRef`: it
  // imports nothing, so there is no cycle to break. Reaching for `forwardRef`
  // "just in case" hides a real cycle the day one appears.
  imports: [forwardRef(() => AuthModule), BusinessesModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}

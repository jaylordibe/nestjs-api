import { Module } from '@nestjs/common';
import { AppVersionsController } from './app-versions.controller';
import { AppVersionsService } from './app-versions.service';

@Module({
  controllers: [AppVersionsController],
  providers: [AppVersionsService],
  exports: [AppVersionsService],
})
export class AppVersionsModule {}

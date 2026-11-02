import { Module } from '@nestjs/common';
import { McpOAuthModule } from '../mcp-oauth/mcp-oauth.module';
import { UsersModule } from '../users/users.module';
import { McpOAuthGuard } from './guards/mcp-oauth.guard';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  imports: [McpOAuthModule, UsersModule],
  controllers: [McpController],
  providers: [McpService, McpOAuthGuard],
})
export class McpModule {}

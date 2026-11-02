import { Module } from '@nestjs/common';
import { McpClientAuthGuard } from './guards/mcp-client-auth.guard';
import { McpController } from './mcp.controller';
import { McpService } from './mcp.service';

@Module({
  controllers: [McpController],
  providers: [McpService, McpClientAuthGuard],
})
export class McpModule {}

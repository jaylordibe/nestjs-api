import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UsersModule } from '../users/users.module';
import { McpOAuthProviderService } from './mcp-oauth-provider.service';
import { OAuthInteractionController } from './oauth-interaction.controller';
import { OAuthPagesService } from './oauth-pages.service';
import { OAuthPayloadRetentionHandler } from './oauth-payload-retention.handler';
import { OAuthProtocolController } from './oauth-protocol.controller';

/**
 * The OAuth 2.1 authorization server MCP clients sign in through
 * (docs/mcp.md). `McpModule` imports it to verify tokens on `/api/mcp`.
 */
@Module({
  imports: [AuthModule, UsersModule],
  controllers: [OAuthProtocolController, OAuthInteractionController],
  providers: [
    McpOAuthProviderService,
    OAuthPagesService,
    OAuthPayloadRetentionHandler,
  ],
  exports: [McpOAuthProviderService],
})
export class McpOAuthModule {}

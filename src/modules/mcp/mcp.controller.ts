import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  McpOAuthGuard,
  type McpAuthenticatedRequest,
} from './guards/mcp-oauth.guard';
import { MCP_THROTTLE } from './mcp.config';
import { McpService } from './mcp.service';

// `/api/mcp` — the Model Context Protocol endpoint (Streamable HTTP). See
// docs/mcp.md.
//
// `@Public()` exempts it from the REST user layer only; every request is
// authenticated by McpOAuthGuard — an MCP OAuth access token for a usable
// account — before the SDK sees it. Excluded from Swagger: it is a JSON-RPC endpoint, not a REST resource.
// `@All()` hands every method to the SDK, which answers the ones the transport
// does not serve (405) itself.
@ApiExcludeController()
@Controller('mcp')
@Public()
@UseGuards(McpOAuthGuard)
@Throttle({ default: MCP_THROTTLE })
export class McpController {
  constructor(private readonly mcpService: McpService) {}

  @All()
  handle(
    @Req() request: McpAuthenticatedRequest,
    @Res() response: Response,
  ): Promise<void> {
    return this.mcpService.handle(request, response);
  }
}

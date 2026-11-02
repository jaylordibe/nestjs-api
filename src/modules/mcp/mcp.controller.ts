import { All, Controller, Req, Res, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../../common/decorators/public.decorator';
import {
  McpClientAuthGuard,
  type McpAuthenticatedRequest,
} from './guards/mcp-client-auth.guard';
import { MCP_THROTTLE } from './mcp.config';
import { McpService } from './mcp.service';

// `/api/mcp` — the Model Context Protocol endpoint (Streamable HTTP). See
// docs/mcp.md.
//
// `@Public()` exempts it from the USER authentication layer only; every request
// is authenticated as an MCP client by McpClientAuthGuard before the SDK sees
// it. Excluded from Swagger: it is a JSON-RPC endpoint, not a REST resource.
// `@All()` hands every method to the SDK, which answers the ones the transport
// does not serve (405) itself.
@ApiExcludeController()
@Controller('mcp')
@Public()
@UseGuards(McpClientAuthGuard)
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

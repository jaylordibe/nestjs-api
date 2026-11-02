import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import {
  type NodeMcpRequestHandler,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  type McpHttpHandler,
  McpServer,
} from '@modelcontextprotocol/server';
import type { Request, Response } from 'express';
import { registerEchoTool } from './tools/echo.tool';
import {
  registerGetServerInfoTool,
  type ServerIdentity,
} from './tools/get-server-info.tool';
import { registerPingTool } from './tools/ping.tool';

// The application's identity — its package name and release version — read
// from the package.json shipped beside `dist/` (the image copies it; under Jest
// the same relative path reaches the repo root).
function readPackageIdentity(): ServerIdentity {
  const packageJson = JSON.parse(
    readFileSync(join(__dirname, '../../../package.json'), 'utf8'),
  ) as { name?: unknown; version?: unknown };
  if (
    typeof packageJson.name !== 'string' ||
    typeof packageJson.version !== 'string'
  ) {
    throw new Error('package.json must declare a string name and version');
  }
  return { name: packageJson.name, version: packageJson.version };
}

// Serves the MCP Streamable HTTP endpoint through the official SDK.
//
// Stateless by construction: `createMcpHandler` builds a fresh McpServer for
// every HTTP request and keeps nothing between requests, so any instance behind
// the load balancer can answer any request and there is no session store. It
// speaks the 2026-07-28 protocol (`server/discover`, per-request `_meta`) and
// answers 2025-era clients (the `initialize` handshake) from the same factory.
//
// Response shape is the SDK's: a 2026-07-28 request gets a single JSON body
// (it would upgrade to SSE only if a tool emitted a notification before its
// result, which none of these do); a 2025-era request gets a one-event SSE
// stream that closes with the result. Neither holds a connection open.
//
// Authentication is NOT done here: McpClientAuthGuard has already verified the
// caller and attached `request.auth` before the controller hands over.
@Injectable()
export class McpService implements OnModuleDestroy {
  private readonly logger = new Logger(McpService.name);
  private readonly handler: McpHttpHandler;
  private readonly nodeHandler: NodeMcpRequestHandler;

  constructor() {
    const identity = readPackageIdentity();
    // The handler reports rejected client input here as well as its own
    // failures, so it is logged as a warning, message only: a caller sending
    // junk must not be able to fill the error log with stack traces.
    const logHandlerError = (error: Error): void => {
      this.logger.warn(`MCP request failed: ${error.message}`);
    };
    // The adapter reports only failures it answered with 500 itself.
    const logAdapterError = (error: Error): void => {
      this.logger.error(error);
    };

    this.handler = createMcpHandler(
      () => {
        // `listChanged: false` because the tool list is fixed at build time and
        // no list-changed notification is ever sent. The SDK defaults it to
        // true once a tool is registered, which invites every 2026-07-28 client
        // to hold a `subscriptions/listen` stream open for notifications that
        // never come; false makes the SDK acknowledge and close that request.
        const server = new McpServer(identity, {
          capabilities: { tools: { listChanged: false } },
        });
        // Registration order is the `tools/list` order, which the spec asks
        // to be deterministic. A new tool is one more register call here.
        registerPingTool(server);
        registerEchoTool(server);
        registerGetServerInfoTool(server, identity);
        return server;
      },
      { onerror: logHandlerError },
    );
    this.nodeHandler = toNodeHandler(this.handler, {
      onerror: logAdapterError,
    });
  }

  // `request.body` is what Nest's JSON body parser produced (bounded by its
  // size limit); when the parser did not run, the adapter reads the stream.
  handle(request: Request, response: Response): Promise<void> {
    return this.nodeHandler(request, response, request.body);
  }

  async onModuleDestroy(): Promise<void> {
    await this.handler.close();
  }
}

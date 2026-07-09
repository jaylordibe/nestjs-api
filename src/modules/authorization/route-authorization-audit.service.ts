import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryService, MetadataScanner } from '@nestjs/core';
import type { InstanceWrapper } from '@nestjs/core/injector/instance-wrapper';
import { AUTHENTICATED_ONLY_KEY } from '../../common/decorators/authenticated-only.decorator';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';

// Refuses to boot when any controller handler has no authorization decision.
//
// Every handler must carry exactly one of `@Public()`, `@AuthenticatedOnly()`,
// or `@RequirePermission(action, subject)`. Forgetting is the single easiest
// way to ship an authorization hole, and no type system catches it — so it is
// caught here, at startup, by name.
//
// `PermissionsGuard` independently denies undecided handlers at runtime. This
// service exists so that failure is a crash on deploy rather than a 403 in a
// code path nobody exercised.
@Injectable()
export class RouteAuthorizationAuditService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RouteAuthorizationAuditService.name);

  constructor(
    private readonly discoveryService: DiscoveryService,
    private readonly metadataScanner: MetadataScanner,
  ) {}

  onApplicationBootstrap(): void {
    const undecidedHandlers = this.findUndecidedHandlers();

    if (undecidedHandlers.length > 0) {
      throw new Error(
        `${undecidedHandlers.length} route handler(s) declare no authorization decision:\n` +
          undecidedHandlers.map((handler) => `  - ${handler}`).join('\n') +
          '\n\nEvery handler must carry exactly one of @Public(), @AuthenticatedOnly(), ' +
          'or @RequirePermission(action, subject). The application will not start.',
      );
    }

    this.logger.log(
      'Route authorization audit passed: every handler declares a decision',
    );
  }

  private findUndecidedHandlers(): string[] {
    const undecided: string[] = [];

    for (const wrapper of this.discoveryService.getControllers()) {
      if (!wrapper.instance || !wrapper.metatype) continue;

      // A controller-level decorator covers all of its handlers.
      if (this.hasAuthorizationDecision(wrapper.metatype)) continue;

      const prototype = Object.getPrototypeOf(wrapper.instance) as object;
      for (const methodName of this.metadataScanner.getAllMethodNames(
        prototype,
      )) {
        const handler = (wrapper.instance as Record<string, unknown>)[
          methodName
        ];
        if (typeof handler !== 'function') continue;

        // Only routed methods matter; plain helpers on a controller do not.
        if (!this.isRouteHandler(handler)) continue;

        if (!this.hasAuthorizationDecision(handler)) {
          undecided.push(`${this.describeController(wrapper)}#${methodName}`);
        }
      }
    }

    return undecided;
  }

  // Nest stamps PATH_METADATA on every @Get/@Post/@Patch/@Delete/… method.
  private isRouteHandler(handler: object): boolean {
    return Reflect.hasMetadata(PATH_METADATA, handler);
  }

  // `Reflect.getMetadata` rather than `Reflector.get`: the latter is typed for
  // classes and route handlers obtained from Nest, while we walk raw prototype
  // methods here.
  private hasAuthorizationDecision(target: object): boolean {
    return (
      Reflect.getMetadata(IS_PUBLIC_KEY, target) === true ||
      Reflect.getMetadata(AUTHENTICATED_ONLY_KEY, target) === true ||
      Reflect.getMetadata(REQUIRE_PERMISSION_KEY, target) !== undefined
    );
  }

  private describeController(wrapper: InstanceWrapper): string {
    return wrapper.metatype?.name ?? 'UnknownController';
  }
}

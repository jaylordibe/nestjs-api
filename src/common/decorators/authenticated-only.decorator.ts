import { SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiBearerAuth, ApiUnauthorizedResponse } from '@nestjs/swagger';

export const AUTHENTICATED_ONLY_KEY = 'authenticatedOnly';

// "A valid token is enough; there is no subject to check a permission against."
//
// The honest third state, alongside `@Public()` and `@RequirePermission()`.
// It exists for actions that operate on the *session* rather than on a
// resource — `POST /auth/logout`, `GET /users/me/permissions`. Inventing a
// synthetic `session.delete` permission just to avoid a third state would put
// a lie in the catalog: every role would have to hold it, so it would gate
// nothing.
//
// Every handler must declare exactly one of the three. A handler that declares
// none fails the boot-time route audit and the application refuses to start.
export const AuthenticatedOnly = (): MethodDecorator & ClassDecorator =>
  applyDecorators(
    SetMetadata(AUTHENTICATED_ONLY_KEY, true),
    ApiBearerAuth(),
    ApiUnauthorizedResponse({
      description: 'Missing, invalid, expired, or revoked access token',
    }),
  );

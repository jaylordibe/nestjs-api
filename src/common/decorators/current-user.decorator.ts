import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Role } from '../enums/role.enum';

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
}

export const CurrentUser = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx
      .switchToHttp()
      .getRequest<{ user: AuthenticatedUser }>();
    return request.user;
  },
);

import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';

export const IS_PUBLIC = 'isPublic';
/** Opt a route out of the global auth guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export interface AuthUser {
  id: string;
  email: string;
}

export type AuthedRequest = Request & { user?: AuthUser };

/** The authenticated user's id, set by AuthGuard. */
export const UserId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.user) throw new Error('UserId used on a route without AuthGuard');
  return req.user.id;
});

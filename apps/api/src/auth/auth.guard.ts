import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthedRequest, IS_PUBLIC } from './auth.decorators.js';
import { AuthService } from './auth.service.js';

export const SESSION_COOKIE = 'cv_session';

/** Global guard: every route requires a live session unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || !token) throw new UnauthorizedException('Not signed in');

    const user = await this.auth.verifySession(token);
    if (!user) throw new UnauthorizedException('Session expired, please sign in again');
    req.user = user;
    return true;
  }
}

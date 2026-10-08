import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { AuthedRequest, AuthUser, IS_PUBLIC } from './auth.decorators.js';

export const SESSION_COOKIE = 'cv_session';

/** Global guard: every route requires a valid session cookie unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [ctx.getHandler(), ctx.getClass()]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const token: unknown = req.cookies?.[SESSION_COOKIE];
    if (typeof token !== 'string' || !token) throw new UnauthorizedException('Not signed in');

    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; email: string }>(token);
      req.user = { id: payload.sub, email: payload.email } satisfies AuthUser;
      return true;
    } catch {
      throw new UnauthorizedException('Session expired, please sign in again');
    }
  }
}

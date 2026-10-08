import { Body, Controller, Get, HttpCode, Post, Res, UnauthorizedException } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CredentialsSchema, type Credentials, type User } from '@cv/shared';
import type { Response } from 'express';
import { config } from '../config.js';
import { ZodPipe } from '../common/zod.pipe.js';
import { Public, UserId } from './auth.decorators.js';
import { SESSION_COOKIE } from './auth.guard.js';
import { AuthService } from './auth.service.js';

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('signup')
  async signup(
    @Body(new ZodPipe(CredentialsSchema)) body: Credentials,
    @Res({ passthrough: true }) res: Response,
  ): Promise<User> {
    const user = await this.auth.signup(body);
    await this.setSession(res, user);
    return user;
  }

  @Public()
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodPipe(CredentialsSchema)) body: Credentials,
    @Res({ passthrough: true }) res: Response,
  ): Promise<User> {
    const user = await this.auth.login(body);
    await this.setSession(res, user);
    return user;
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }

  @Get('me')
  async me(@UserId() userId: string): Promise<User> {
    const user = await this.auth.findUser(userId);
    if (!user) throw new UnauthorizedException('Account no longer exists');
    return user;
  }

  private async setSession(res: Response, user: User) {
    res.cookie(SESSION_COOKIE, await this.auth.issueToken(user), {
      httpOnly: true,
      // Lax blocks the cookie on cross-site POSTs, which is our CSRF protection
      // (the API only accepts JSON / multipart from our own origin).
      sameSite: 'lax',
      secure: config.secureCookies,
      maxAge: SESSION_TTL_MS,
      path: '/',
    });
  }
}

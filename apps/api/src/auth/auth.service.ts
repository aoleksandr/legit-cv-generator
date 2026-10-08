import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Credentials, User } from '@cv/shared';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthUser } from './auth.decorators.js';

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionClaims {
  sub: string;
  sid: string;
}

@Injectable()
export class AuthService {
  /** Verified against when the email is unknown, so login timing doesn't reveal which emails exist. */
  private readonly dummyHash = argon2.hash('timing-equaliser-password');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async signup({ email, password }: Credentials): Promise<User> {
    const passwordHash = await argon2.hash(password);
    try {
      const user = await this.prisma.user.create({ data: { email, passwordHash } });
      return { id: user.id, email: user.email };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('An account with this email already exists');
      }
      throw err;
    }
  }

  async login({ email, password }: Credentials): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    const ok = await argon2.verify(user?.passwordHash ?? (await this.dummyHash), password);
    if (!user || !ok) throw new UnauthorizedException('Invalid email or password');
    return { id: user.id, email: user.email };
  }

  async findUser(id: string): Promise<User | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? { id: user.id, email: user.email } : null;
  }

  /** Starts a session for one device and returns the signed cookie value that names it. */
  async createSession(user: User): Promise<string> {
    const now = Date.now();
    const [session] = await this.prisma.$transaction([
      this.prisma.session.create({ data: { userId: user.id, expiresAt: new Date(now + SESSION_TTL_MS) } }),
      // Housekeeping: expired rows are never valid again.
      this.prisma.session.deleteMany({ where: { userId: user.id, expiresAt: { lt: new Date(now) } } }),
    ]);
    return this.jwt.signAsync({ sub: user.id, sid: session.id } satisfies SessionClaims);
  }

  /**
   * The signed-in user, or null. A valid signature is not enough: the session row must
   * still exist (not logged out, not expired) and so must its user.
   */
  async verifySession(token: string): Promise<AuthUser | null> {
    const claims = await this.claims(token);
    if (!claims) return null;
    const session = await this.prisma.session.findFirst({
      where: { id: claims.sid, userId: claims.sub, expiresAt: { gt: new Date() } },
      select: { user: { select: { id: true, email: true } } },
    });
    return session?.user ?? null;
  }

  /** Revokes the session the token names; other devices stay signed in. */
  async endSession(token: string): Promise<void> {
    const claims = await this.claims(token);
    if (claims) await this.prisma.session.deleteMany({ where: { id: claims.sid, userId: claims.sub } });
  }

  private async claims(token: string): Promise<SessionClaims | null> {
    try {
      const payload = await this.jwt.verifyAsync<Partial<SessionClaims>>(token);
      return isUuid(payload.sub) && isUuid(payload.sid) ? { sub: payload.sub, sid: payload.sid } : null;
    } catch {
      return null;
    }
  }
}

const isUuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

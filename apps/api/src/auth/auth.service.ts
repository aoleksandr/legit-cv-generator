import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Credentials, User } from '@cv/shared';
import * as argon2 from 'argon2';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

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

  issueToken(user: User): Promise<string> {
    return this.jwt.signAsync({ sub: user.id, email: user.email });
  }
}

import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { config } from '../config.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard } from './auth.guard.js';
import { AuthService, SESSION_TTL_MS } from './auth.service.js';

@Module({
  imports: [JwtModule.register({ secret: config.jwtSecret, signOptions: { expiresIn: SESSION_TTL_MS / 1000 } })],
  controllers: [AuthController],
  providers: [AuthService, { provide: APP_GUARD, useClass: AuthGuard }],
})
export class AuthModule {}

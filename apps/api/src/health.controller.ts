import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.decorators.js';
import { config } from './config.js';
import { PrismaService } from './prisma/prisma.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  async health() {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, ai: config.anthropicApiKey ? 'configured' : 'missing ANTHROPIC_API_KEY' };
  }
}

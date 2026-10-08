import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import type { Response } from 'express';

/** Uniform `{ statusCode, message, details? }` error bodies; never leaks internals on 500. */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === 'string'
          ? body
          : Array.isArray((body as { message?: unknown }).message)
            ? (body as { message: string[] }).message.join(', ')
            : String((body as { message?: unknown }).message ?? exception.message);
      const details = typeof body === 'object' ? (body as { details?: unknown }).details : undefined;
      res.status(status).json({ statusCode: status, message, ...(details ? { details } : {}) });
      return;
    }

    this.logger.error(exception instanceof Error ? exception.stack : String(exception));
    res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: 'Internal server error' });
  }
}

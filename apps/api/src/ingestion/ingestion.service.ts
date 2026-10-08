import { BadRequestException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { LIMITS } from '@cv/shared';
import { extractText, getDocumentProxy } from 'unpdf';

const MAX_PAGES = 20;
const EXTRACT_TIMEOUT_MS = 15_000;

/**
 * Turns an uploaded PDF into plain text. The file itself is untrusted: we
 * check the magic bytes (not the client-provided MIME type), bound the page
 * count and extraction time, and reject PDFs with no text layer (scans).
 */
@Injectable()
export class IngestionService {
  private readonly logger = new Logger(IngestionService.name);

  async pdfToText(buffer: Buffer): Promise<string> {
    if (buffer.length === 0) throw new BadRequestException('The uploaded file is empty');
    if (buffer.length > LIMITS.pdfMaxBytes) {
      throw new BadRequestException(`The PDF is larger than ${LIMITS.pdfMaxBytes / 1024 / 1024} MB`);
    }
    if (buffer.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new BadRequestException('The uploaded file is not a PDF');
    }

    let text: string;
    try {
      text = await withTimeout(this.extract(buffer), EXTRACT_TIMEOUT_MS);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`PDF extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new UnprocessableEntityException('We could not read this PDF. Try another file or paste the text instead.');
    }

    const cleaned = cleanText(text);
    if (cleaned.length < LIMITS.sourceTextMinChars) {
      throw new UnprocessableEntityException(
        'This PDF has no selectable text (it may be a scanned image). Please paste your CV as text instead.',
      );
    }
    if (cleaned.length > LIMITS.sourceTextMaxChars) {
      throw new BadRequestException(
        `The PDF contains too much text (over ${LIMITS.sourceTextMaxChars} characters). Please upload a shorter CV.`,
      );
    }
    return cleaned;
  }

  private async extract(buffer: Buffer): Promise<string> {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    if (pdf.numPages > MAX_PAGES) {
      throw new BadRequestException(`The PDF has more than ${MAX_PAGES} pages`);
    }
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }
}

/** Normalise whitespace and drop control characters; keep line breaks, which carry structure. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

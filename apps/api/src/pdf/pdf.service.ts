import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import type { CvDocument } from '@cv/shared';
import { CvPdf } from './cv-document.js';

@Injectable()
export class PdfService {
  render(cv: CvDocument, title: string): Promise<Buffer> {
    return renderToBuffer(CvPdf({ cv, title }));
  }
}

/** "Jane Doe – Backend.pdf" for the header, with an ASCII fallback for old clients. */
export function contentDisposition(baseName: string): string {
  const name = (
    baseName
      .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'cv'
  ).slice(0, 100);
  const ascii =
    name
      .normalize('NFKD')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'cv';
  return `attachment; filename="${ascii}.pdf"; filename*=UTF-8''${encodeURIComponent(`${name}.pdf`)}`;
}

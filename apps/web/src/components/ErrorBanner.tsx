import type { ReactNode } from 'react';
import { ApiError } from '../api';

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const details = Array.isArray(err.details)
      ? (err.details as { path?: string; message?: string }[])
          .map((d) => (d.path ? `${d.path}: ${d.message}` : d.message))
          .join('; ')
      : '';
    return details ? `${err.message} (${details})` : err.message;
  }
  return err instanceof Error ? err.message : 'Something went wrong';
}

export function ErrorBanner({ error, children }: { error?: unknown; children?: ReactNode }) {
  if (!error && !children) return null;
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {children ?? errorMessage(error)}
    </div>
  );
}

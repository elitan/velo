import { ORPCError } from '@orpc/server';

export function userFacingError(error: unknown, fallback: string): ORPCError<'BAD_REQUEST', undefined> {
  return new ORPCError('BAD_REQUEST', {
    message: getErrorMessage(error, fallback),
    cause: error,
  });
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) {
    return formatErrorMessage(error);
  }

  if (typeof error === 'string' && error.trim()) {
    return error;
  }

  return fallback;
}

function formatErrorMessage(error: Error): string {
  const parts = [error.message];
  const detail = getStringProperty(error, 'detail');
  const hint = getStringProperty(error, 'hint');

  if (detail) {
    parts.push(detail);
  }

  if (hint) {
    parts.push(`Hint: ${hint}`);
  }

  return parts.join('\n');
}

function getStringProperty(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const item = (value as Record<string, unknown>)[key];

  if (typeof item === 'string' && item.trim()) {
    return item;
  }

  return null;
}

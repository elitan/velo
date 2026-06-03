import { ORPCError } from '@orpc/server';

export function userFacingError(error: unknown, fallback: string): ORPCError<'BAD_REQUEST', undefined> {
  return new ORPCError('BAD_REQUEST', {
    message: getFullErrorMessage(error, fallback),
    cause: error,
  });
}

export function internalError(error: unknown, fallback: string): ORPCError<'INTERNAL_SERVER_ERROR', undefined> {
  if (error instanceof ORPCError) {
    return error as ORPCError<'INTERNAL_SERVER_ERROR', undefined>;
  }

  return new ORPCError('INTERNAL_SERVER_ERROR', {
    message: getFullErrorMessage(error, fallback),
    cause: error,
  });
}

export function getFullErrorMessage(error: unknown, fallback: string): string {
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
  const cause = formatCause(error.cause);

  if (detail) {
    parts.push(detail);
  }

  if (hint) {
    parts.push(`Hint: ${hint}`);
  }

  if (cause && cause !== error.message) {
    parts.push(`Caused by: ${cause}`);
  }

  return parts.join('\n');
}

function formatCause(cause: unknown): string | null {
  if (!cause) {
    return null;
  }

  if (cause instanceof Error && cause.message.trim()) {
    return formatErrorMessage(cause);
  }

  if (typeof cause === 'string' && cause.trim()) {
    return cause;
  }

  return null;
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

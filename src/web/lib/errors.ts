export function getMutationErrorMessage(error: unknown, fallback: string): string {
  const message = getErrorMessageCandidate(error)
    || getErrorMessageCandidate(getObjectProperty(error, 'cause'))
    || fallback;

  return message.trim() || fallback;
}

function getErrorMessageCandidate(value: unknown): string | null {
  if (!value) {
    return null;
  }

  if (typeof value === 'string' && value.trim()) {
    return value;
  }

  if (value instanceof Error && value.message.trim()) {
    return withErrorData(value.message, value);
  }

  const message = getStringProperty(value, 'message')
    || getStringProperty(value, 'error')
    || getNestedStringProperty(value, ['data', 'message'])
    || getNestedStringProperty(value, ['data', 'error'])
    || getNestedStringProperty(value, ['data', 'body', 'message'])
    || getNestedStringProperty(value, ['data', 'body', 'error']);

  if (!message) {
    return null;
  }

  return withErrorData(message, value);
}

function withErrorData(message: string, value: unknown): string {
  const parts = [message];
  const detail = getNestedStringProperty(value, ['data', 'detail'])
    || getNestedStringProperty(value, ['data', 'body', 'detail'])
    || getStringProperty(value, 'detail');
  const hint = getNestedStringProperty(value, ['data', 'hint'])
    || getNestedStringProperty(value, ['data', 'body', 'hint'])
    || getStringProperty(value, 'hint');

  if (detail && detail !== message) {
    parts.push(detail);
  }

  if (hint) {
    parts.push(`Hint: ${hint}`);
  }

  return parts.join('\n');
}

function getNestedStringProperty(value: unknown, path: string[]): string | null {
  let current = value;

  for (const key of path) {
    current = getObjectProperty(current, key);
  }

  return typeof current === 'string' && current.trim() ? current : null;
}

function getStringProperty(value: unknown, key: string): string | null {
  const item = getObjectProperty(value, key);

  return typeof item === 'string' && item.trim() ? item : null;
}

function getObjectProperty(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') {
    return null;
  }

  return (value as Record<string, unknown>)[key];
}

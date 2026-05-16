export const PRODUCTION_WRITE_CONFIRMATION = 'write production';

const READ_ONLY_KEYWORDS = new Set(['select', 'show', 'values']);
const WRITE_KEYWORDS = /\b(alter|call|comment|copy|create|delete|drop|execute|grant|insert|merge|reindex|refresh|revoke|set|truncate|update|vacuum)\b/i;

export function isProductionBranchId(branchId: string): boolean {
  const normalized = branchId.trim().toLowerCase();
  return normalized === 'production' || normalized === 'prod';
}

export function isConfirmedProductionWrite(value: string | null | undefined): boolean {
  return value?.trim().toLowerCase() === PRODUCTION_WRITE_CONFIRMATION;
}

export function isReadOnlySql(sql: string): boolean {
  const statements = splitSqlStatements(sql)
    .map(function cleanStatement(statement) {
      return stripCommentsAndStrings(statement).trim();
    })
    .filter(function keepStatement(statement) {
      return statement.length > 0;
    });

  return statements.length > 0 && statements.every(isReadOnlyStatement);
}

function isReadOnlyStatement(statement: string): boolean {
  const firstKeyword = getFirstKeyword(statement);

  if (!firstKeyword) {
    return false;
  }

  if (READ_ONLY_KEYWORDS.has(firstKeyword)) {
    return true;
  }

  if (firstKeyword === 'with') {
    return !WRITE_KEYWORDS.test(statement) && /\b(select|values)\b/i.test(statement);
  }

  if (firstKeyword === 'explain') {
    return isReadOnlyExplain(statement);
  }

  return false;
}

function isReadOnlyExplain(statement: string): boolean {
  if (/\banalyze\b/i.test(statement)) {
    return false;
  }

  const explainedStatement = statement
    .replace(/^explain\s*(\([^)]*\))?\s*/i, '')
    .trim();

  return explainedStatement.length > 0 && isReadOnlyStatement(explainedStatement);
}

function getFirstKeyword(statement: string): string | null {
  return statement.match(/[a-z_][a-z0-9_]*/i)?.[0]?.toLowerCase() || null;
}

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let index = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (char === '\n') {
        lineComment = false;
      }
      index += 1;
      continue;
    }

    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        index += dollarQuote.length;
        dollarQuote = null;
        continue;
      }
      index += 1;
      continue;
    }

    if (singleQuoted) {
      if (char === "'" && next === "'") {
        index += 2;
        continue;
      }
      if (char === "'") {
        singleQuoted = false;
      }
      index += 1;
      continue;
    }

    if (doubleQuoted) {
      if (char === '"' && next === '"') {
        index += 2;
        continue;
      }
      if (char === '"') {
        doubleQuoted = false;
      }
      index += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      lineComment = true;
      index += 2;
      continue;
    }

    if (char === '/' && next === '*') {
      blockComment = true;
      index += 2;
      continue;
    }

    if (char === "'") {
      singleQuoted = true;
      index += 1;
      continue;
    }

    if (char === '"') {
      doubleQuoted = true;
      index += 1;
      continue;
    }

    if (char === '$') {
      const match = sql.slice(index).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        index += dollarQuote.length;
        continue;
      }
    }

    if (char === ';') {
      statements.push(sql.slice(start, index));
      start = index + 1;
    }

    index += 1;
  }

  statements.push(sql.slice(start));
  return statements;
}

function stripCommentsAndStrings(sql: string): string {
  let result = '';
  let index = 0;
  let singleQuoted = false;
  let doubleQuoted = false;
  let lineComment = false;
  let blockComment = false;
  let dollarQuote: string | null = null;

  while (index < sql.length) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      result += char === '\n' ? '\n' : ' ';
      if (char === '\n') {
        lineComment = false;
      }
      index += 1;
      continue;
    }

    if (blockComment) {
      result += ' ';
      if (char === '*' && next === '/') {
        result += ' ';
        blockComment = false;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }

    if (dollarQuote) {
      if (sql.startsWith(dollarQuote, index)) {
        result += ' '.repeat(dollarQuote.length);
        index += dollarQuote.length;
        dollarQuote = null;
        continue;
      }
      result += ' ';
      index += 1;
      continue;
    }

    if (singleQuoted) {
      result += ' ';
      if (char === "'" && next === "'") {
        result += ' ';
        index += 2;
        continue;
      }
      if (char === "'") {
        singleQuoted = false;
      }
      index += 1;
      continue;
    }

    if (doubleQuoted) {
      result += ' ';
      if (char === '"' && next === '"') {
        result += ' ';
        index += 2;
        continue;
      }
      if (char === '"') {
        doubleQuoted = false;
      }
      index += 1;
      continue;
    }

    if (char === '-' && next === '-') {
      result += '  ';
      lineComment = true;
      index += 2;
      continue;
    }

    if (char === '/' && next === '*') {
      result += '  ';
      blockComment = true;
      index += 2;
      continue;
    }

    if (char === "'") {
      result += ' ';
      singleQuoted = true;
      index += 1;
      continue;
    }

    if (char === '"') {
      result += ' ';
      doubleQuoted = true;
      index += 1;
      continue;
    }

    if (char === '$') {
      const match = sql.slice(index).match(/^\$[a-zA-Z_][a-zA-Z0-9_]*\$|^\$\$/);
      if (match) {
        dollarQuote = match[0];
        result += ' '.repeat(dollarQuote.length);
        index += dollarQuote.length;
        continue;
      }
    }

    result += char;
    index += 1;
  }

  return result;
}

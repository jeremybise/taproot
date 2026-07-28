/**
 * Value coercion shared by the SQLite-family drivers.
 *
 * `node:sqlite` and D1 both reject JavaScript booleans outright ("Provided value cannot be bound
 * to SQLite parameter N"), and neither understands `Date` or `undefined`. Rather than making every
 * call site remember that, the drivers normalise parameters on the way in.
 */

/** Values a SQLite-family driver will accept as a bound parameter. */
export type SqlValue = string | number | bigint | null | Uint8Array;

/**
 * Normalise a single query parameter into something SQLite/D1 will bind.
 *
 * Booleans become 0/1, dates become ISO-8601 strings (matching the `Timestamp` column type),
 * and `undefined` becomes NULL so optional fields do not blow up at the driver boundary.
 */
export function toSqlValue(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;

  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'string':
    case 'number':
    case 'bigint':
      return value as SqlValue;
    case 'object':
      if (value instanceof Date) return value.toISOString();
      if (value instanceof Uint8Array) return value;
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      }
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      // Plain objects and arrays are a mistake at this layer: JSON columns are stringified
      // explicitly in the repositories so the conversion stays visible in the code.
      throw new TypeError(
        `Cannot bind a plain object to a SQL parameter. JSON columns must be stringified by the ` +
          `repository before reaching the driver. Received: ${describe(value)}`,
      );
    default:
      throw new TypeError(`Cannot bind value of type ${typeof value} to a SQL parameter.`);
  }
}

export function toSqlParameters(parameters: readonly unknown[]): SqlValue[] {
  return parameters.map(toSqlValue);
}

function describe(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json && json.length > 80 ? `${json.slice(0, 80)}…` : (json ?? String(value));
  } catch {
    return Object.prototype.toString.call(value);
  }
}

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

/** Read a SQLite integer-backed boolean column. */
export function toBool(value: number | boolean | null | undefined): boolean {
  return value === true || value === 1;
}

/** Write a boolean to an integer-backed column. */
export function fromBool(value: boolean | undefined | null): number {
  return value ? 1 : 0;
}

/**
 * Parse a JSON text column, falling back rather than throwing.
 *
 * A malformed `data` blob should not take down an entire admin list view; the caller gets the
 * fallback and the row stays visible and editable.
 */
export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** Serialise a value for a JSON text column. */
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

/** Current time in the ISO-8601 form used by every `Timestamp` column. */
export function now(): string {
  return new Date().toISOString();
}

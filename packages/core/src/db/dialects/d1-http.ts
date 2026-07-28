import type { D1DatabaseLike, D1PreparedStatement, D1Result } from './d1.js';

export interface D1HttpConfig {
  accountId: string;
  databaseId: string;
  /** Cloudflare API token with the `D1:Edit` permission. */
  apiToken: string;
  /** Override for testing. */
  baseUrl?: string;
}

/**
 * A `D1DatabaseLike` implementation backed by Cloudflare's D1 REST API.
 *
 * This exists so `npm run db:migrate:remote` can run the *same* Kysely migrations against a
 * deployed D1 database from a laptop or CI, with no Worker involved. Keeping one migration source
 * of truth is the point: the alternative is maintaining a parallel set of `.sql` files for
 * `wrangler d1 migrations apply` and hoping the two never drift.
 *
 * Intended for CLI use only — inside a Worker, use the real binding, which is faster and needs no
 * API token.
 */
export class D1HttpDatabase implements D1DatabaseLike {
  readonly #config: D1HttpConfig;

  constructor(config: D1HttpConfig) {
    this.#config = config;
  }

  prepare(sql: string): D1PreparedStatement {
    return new D1HttpPreparedStatement(this.#config, sql, []);
  }

  /**
   * Not atomic, unlike the real binding's `batch()`.
   *
   * The REST API has no batch endpoint that accepts per-statement parameters, so this runs
   * sequentially. That is fine for the only caller — the migration CLI, which runs statements one
   * at a time anyway because `D1Adapter` reports `supportsTransactionalDdl: false`. Application
   * code must never reach this path; it uses the binding, where `batch()` is genuinely atomic.
   */
  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const results: D1Result<T>[] = [];
    for (const statement of statements) {
      results.push(await statement.all<T>());
    }
    return results;
  }
}

class D1HttpPreparedStatement implements D1PreparedStatement {
  constructor(
    private readonly config: D1HttpConfig,
    private readonly sql: string,
    private readonly params: unknown[],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1HttpPreparedStatement(this.config, this.sql, values);
  }

  async all<T = unknown>(): Promise<D1Result<T>> {
    const base = this.config.baseUrl ?? 'https://api.cloudflare.com/client/v4';
    const url = `${base}/accounts/${this.config.accountId}/d1/database/${this.config.databaseId}/query`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sql: this.sql, params: this.params }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `D1 HTTP API returned ${response.status} ${response.statusText}. ` +
          `Check TAPROOT_CF_API_TOKEN has the D1:Edit permission and that the account and ` +
          `database IDs are correct.${body ? `\n${truncate(body)}` : ''}`,
      );
    }

    const payload = (await response.json()) as {
      success: boolean;
      errors?: { code: number; message: string }[];
      result?: D1Result<T>[];
    };

    if (!payload.success) {
      const detail = payload.errors?.map((e) => `[${e.code}] ${e.message}`).join('; ') ?? 'unknown';
      throw new Error(`D1 query failed: ${detail}\nSQL: ${truncate(this.sql)}`);
    }

    const first = payload.result?.[0];
    if (!first) {
      return { results: [], success: true, meta: {} };
    }
    return first;
  }
}

function truncate(text: string, max = 400): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

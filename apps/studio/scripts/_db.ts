import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createDb, D1HttpDatabase, type TaprootDb } from '@taprootcms/core';

import { loadEnv, sqlitePath } from './_env.ts';

/**
 * Open the database a CLI script should act on.
 *
 * `--remote` targets the deployed D1 database over Cloudflare's REST API, so the exact same
 * migrations run locally and in production without maintaining a parallel set of `.sql` files.
 */
export async function openDb(argv: string[] = process.argv): Promise<{
  handle: TaprootDb;
  target: string;
}> {
  const env = loadEnv();
  const remote = argv.includes('--remote');

  if (remote) {
    const accountId = env.TAPROOT_CF_ACCOUNT_ID;
    const databaseId = env.TAPROOT_CF_D1_ID;
    const apiToken = env.TAPROOT_CF_API_TOKEN;

    if (!accountId || !databaseId || !apiToken) {
      throw new Error(
        'Remote mode needs TAPROOT_CF_ACCOUNT_ID, TAPROOT_CF_D1_ID, and TAPROOT_CF_API_TOKEN. ' +
          'See DEPLOYMENT.md for how to obtain each.',
      );
    }

    const handle = await createDb({
      driver: 'd1',
      database: new D1HttpDatabase({ accountId, databaseId, apiToken }),
    });

    return { handle, target: `remote D1 database ${databaseId}` };
  }

  const location = sqlitePath(env);
  mkdirSync(dirname(location), { recursive: true });

  return { handle: await createDb({ driver: 'sqlite', location }), target: location };
}

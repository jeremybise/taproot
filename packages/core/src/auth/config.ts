/**
 * Auth configuration, resolved once at startup.
 *
 * **Email and password is the primary sign-in method**, and OAuth is an optional addition. That is
 * a reversal: password sign-in began as a dev-only convenience that `resolveAuthConfig` refused to
 * boot with outside development, on the reasoning that a password backdoor which is meant to be
 * off and quietly is not is exactly the bug that survives to production.
 *
 * The reasoning was right about a *backdoor* and wrong about a *front door*. A deliberate,
 * documented, rate-limited password provider is not a backdoor — the thing that made it dangerous
 * was being a hidden second way in, not the passwords. So it is now the visible first way in, and
 * the guard that remains is the one that still means something: a deployment must have some way to
 * sign in, and `TAPROOT_PASSWORD_AUTH=0` with no OAuth provider configured is a locked building.
 *
 * Registering an OAuth app is real setup a fresh clone cannot do, which is the other half of why
 * this is the default: it is what keeps `npm run dev` working with nothing but `npm install`.
 */

export interface OAuthProviderConfig {
  clientId: string;
  clientSecret: string;
  /** Entra only. */
  tenant?: string;
}

export interface AuthConfig {
  /** Absolute origin used to build OAuth redirect URIs, e.g. `https://cms.example.edu`. */
  origin: string;
  /** Whether email/password sign-in is available. On unless explicitly turned off. */
  passwordAuthEnabled: boolean;
  /** `Secure` is dropped for local HTTP, where the browser would otherwise discard the cookie. */
  secureCookies: boolean;
  providers: {
    google?: OAuthProviderConfig;
    github?: OAuthProviderConfig;
    microsoft?: OAuthProviderConfig;
  };
}

export interface AuthEnv {
  NODE_ENV?: string;
  /** `0` turns email/password sign-in off, for a deployment that wants OAuth only. */
  TAPROOT_PASSWORD_AUTH?: string;
  /**
   * The former dev-only switch.
   *
   * Read only to fail loudly: password sign-in is now on by default, so an environment still
   * setting this is configured against a model that no longer exists, and silently ignoring it
   * would leave someone believing they had restricted something.
   */
  TAPROOT_DEV_AUTH?: string;
  TAPROOT_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT?: string;
}

export class AuthConfigError extends Error {
  override name = 'AuthConfigError';
}

export function resolveAuthConfig(env: AuthEnv): AuthConfig {
  const isDevelopment = (env.NODE_ENV ?? 'development') === 'development';

  /**
   * A stale `TAPROOT_DEV_AUTH` is an error rather than something to ignore.
   *
   * It used to mean "switch the password provider on, local only". Password sign-in is now on by
   * default, so an environment still setting it either believes it is enabling something already
   * enabled, or — worse, for the `=0` case — believes it has turned something off. Both deserve to
   * be said out loud at boot rather than discovered by an unexpected login page.
   */
  if (env.TAPROOT_DEV_AUTH !== undefined) {
    throw new AuthConfigError(
      'TAPROOT_DEV_AUTH is no longer used. Email and password sign-in is now the primary ' +
        'method and is on by default; set TAPROOT_PASSWORD_AUTH=0 to turn it off. Remove ' +
        'TAPROOT_DEV_AUTH from your environment.',
    );
  }

  const passwordAuthEnabled = env.TAPROOT_PASSWORD_AUTH !== '0';

  const providers: AuthConfig['providers'] = {};
  if (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
    };
  }
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    };
  }
  if (env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET) {
    providers.microsoft = {
      clientId: env.MICROSOFT_CLIENT_ID,
      clientSecret: env.MICROSOFT_CLIENT_SECRET,
      tenant: env.MICROSOFT_TENANT ?? 'common',
    };
  }

  /**
   * An instance with no way in at all is a configuration error worth catching at boot.
   *
   * Now reachable only by turning password auth off *and* configuring no provider, which is a
   * locked building rather than an oversight — but it is still cheaper to say so at startup than
   * to discover it at a login page with no buttons on it. Checked in development too: it is the
   * same mistake either way, and it used to be possible to develop happily against a config that
   * would refuse to boot in production.
   */
  if (!passwordAuthEnabled && Object.keys(providers).length === 0) {
    throw new AuthConfigError(
      'No authentication method is configured: TAPROOT_PASSWORD_AUTH=0 turns off email and ' +
        'password sign-in, and no OAuth provider is set. Either unset TAPROOT_PASSWORD_AUTH or ' +
        'configure a provider (GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET, or ' +
        'MICROSOFT_CLIENT_ID/SECRET). See DEPLOYMENT.md.',
    );
  }

  return {
    origin: env.TAPROOT_ORIGIN ?? 'http://localhost:4321',
    passwordAuthEnabled,
    secureCookies: !isDevelopment,
    providers,
  };
}

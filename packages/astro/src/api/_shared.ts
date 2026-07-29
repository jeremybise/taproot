import type { APIContext } from 'astro';
import type { User } from '@taproot/core';
import {
  ContentItemError,
  ContentTypeError,
  MenuError,
  ReusableBlockError,
  RevisionError,
  TaxonomyError,
} from '@taproot/core';
import { z } from 'zod';

import { getTaproot, type Role, hasRole } from '../runtime/guards.js';
import type { TaprootContext } from '../runtime/context.js';

/**
 * Shared plumbing for the REST API.
 *
 * Every handler goes through `handle`, which centralises three things that are easy to get subtly
 * wrong per-route: the auth gate, mapping domain errors to status codes, and never leaking an
 * internal error message to the client.
 */

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export interface ApiErrorBody {
  error: string;
  /** Per-field messages, keyed by field `api_id`, when a validation failure has them. */
  fields?: Record<string, string[]>;
}

export function apiError(status: number, message: string, fields?: Record<string, string[]>): Response {
  const body: ApiErrorBody = fields ? { error: message, fields } : { error: message };
  return json(body, { status });
}

export interface HandlerArgs {
  context: APIContext;
  taproot: TaprootContext;
  user: User;
}

export interface HandleOptions {
  /** Minimum role required. Omit for routes that only need a signed-in user. */
  role?: Role;
}

/**
 * Wrap an API handler with authentication, authorization, and error mapping.
 *
 * Unexpected errors are logged server-side and reported as a generic 500 — an exception's message
 * can carry SQL fragments or file paths, which should not reach an HTTP client.
 */
export function handle(
  handler: (args: HandlerArgs) => Promise<Response>,
  options: HandleOptions = {},
) {
  return async (context: APIContext): Promise<Response> => {
    let taproot: TaprootContext;
    try {
      taproot = getTaproot(context.locals);
    } catch (error) {
      console.error('[taproot] context unavailable', error);
      return apiError(500, 'Taproot is not configured correctly.');
    }

    if (!taproot.user) {
      return apiError(401, 'Sign in to continue.');
    }

    if (options.role && !hasRole(taproot.user, options.role)) {
      return apiError(403, `This action requires the ${options.role} role or higher.`);
    }

    try {
      return await handler({ context, taproot, user: taproot.user });
    } catch (error) {
      return mapError(error);
    }
  };
}

/** Map known domain errors to meaningful statuses; everything else becomes an opaque 500. */
export function mapError(error: unknown): Response {
  if (error instanceof ContentItemError) {
    switch (error.code) {
      case 'not_found':
        return apiError(404, error.message);
      case 'validation_failed':
        return apiError(422, error.message, error.fieldErrors);
      case 'cycle':
      case 'invalid_parent':
      case 'singleton_exists':
        return apiError(409, error.message);
      default:
        return apiError(400, error.message);
    }
  }

  if (error instanceof ContentTypeError) {
    switch (error.code) {
      case 'not_found':
        return apiError(404, error.message);
      case 'duplicate_api_id':
      case 'in_use':
        return apiError(409, error.message);
      case 'immutable':
        return apiError(422, error.message);
      default:
        return apiError(400, error.message);
    }
  }

  if (error instanceof MenuError) {
    switch (error.code) {
      case 'not_found':
        return apiError(404, error.message);
      case 'duplicate_api_id':
        return apiError(409, error.message);
      case 'invalid_target':
      case 'cycle':
      case 'wrong_menu':
        return apiError(422, error.message);
      default:
        return apiError(400, error.message);
    }
  }

  if (error instanceof TaxonomyError) {
    switch (error.code) {
      case 'not_found':
        return apiError(404, error.message);
      case 'duplicate_api_id':
      case 'in_use':
        return apiError(409, error.message);
      case 'cycle':
      case 'invalid_parent':
      case 'not_hierarchical':
        return apiError(422, error.message);
      default:
        return apiError(400, error.message);
    }
  }

  if (error instanceof ReusableBlockError) {
    switch (error.code) {
      case 'not_found':
        return apiError(404, error.message);
      case 'in_use':
        return apiError(409, error.message);
      case 'validation_failed':
        return apiError(422, error.message, error.fieldErrors);
      default:
        return apiError(400, error.message);
    }
  }

  if (error instanceof RevisionError) {
    // `wrong_item` is a 404 rather than a 403: the revision exists, but not at the URL it was
    // requested from, and confirming it exists elsewhere tells a caller something they should not
    // learn from a mistyped id.
    return apiError(404, error.message);
  }

  if (error instanceof z.ZodError) {
    return apiError(422, 'Request body failed validation.', groupZodIssues(error));
  }

  console.error('[taproot] unhandled API error', error);
  return apiError(500, 'Something went wrong. Check the server logs for details.');
}

/** Parse and validate a JSON request body. */
export async function readJson<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new z.ZodError([
      { code: 'custom', path: [], message: 'Request body must be valid JSON.', input: undefined },
    ]);
  }
  return schema.parse(raw);
}

function groupZodIssues(error: z.ZodError): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join('.') : '_';
    (grouped[key] ??= []).push(issue.message);
  }
  return grouped;
}

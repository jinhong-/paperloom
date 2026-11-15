/**
 * Where the server is reached from the outside.
 *
 * A server that is behind a path prefix, such as Home Assistant's
 * ingress endpoint, is reached at <prefix>/api/device/sync. The proxy
 * takes the prefix off before the request arrives, so the request's own
 * path cannot say what the prefix was.
 *
 * The proxy says so in a header, and that is what is used. A server that
 * is not behind a prefix has none, and the path is the root.
 *
 * The frame is told this path so that the addresses it shows the owner,
 * as a QR code, are the ones that can be opened. The frame knows the
 * address of the server it was pointed at, and the path is the rest of
 * it.
 */

import type { FastifyRequest } from "fastify";

/**
 * The path the server is reached at, without the API's own path.
 *
 * @param request The request that came in.
 * @param apiPath The API's own path, which is taken off.
 */
export function publicPath(request: FastifyRequest, apiPath: string): string {
  return publicPathFrom(request.headers, apiPath);
}

/**
 * The path the server is reached at, from the headers alone.
 *
 * @param headers The headers of the request that came in.
 * @param apiPath The API's own path, which is taken off.
 */
export function publicPathFrom(
  headers: Record<string, string | string[] | undefined>,
  apiPath: string,
): string {
  /* The prefix the proxy stripped off. */
  const forwarded = headers["x-forwarded-prefix"];
  const prefix = Array.isArray(forwarded) ? forwarded[0] : forwarded;

  if (prefix) {
    const trimmed = prefix.replace(/\/+$/, "");
    return trimmed.length === 0 ? "" : trimmed;
  }

  /* Without one, the API's path is what was taken off, so what is left is
   * the root of wherever the server is. */
  return apiPath.replace(/\/api\/device$/, "");
}

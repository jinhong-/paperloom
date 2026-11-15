/**
 * Fastify type augmentation.
 *
 * Adds the `rawBody` field, which carries the unparsed request bytes. The
 * device signature scheme digests the exact bytes the client sent, so the
 * raw buffer must survive JSON parsing.
 */

import "fastify";

declare module "fastify" {
  interface FastifyRequest {
    /** The unparsed request body. Set by the JSON content-type parser. */
    rawBody?: Buffer;
  }
}

export {};

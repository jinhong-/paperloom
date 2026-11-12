/*
 * Device identity and request signing.
 */

#ifndef CRYPTO_H
#define CRYPTO_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/* The size of the raw P-256 private scalar. */
#define CRYPTO_PRIVATE_KEY_BYTES 32

/**
 * Initialise the PSA crypto subsystem.
 */
esp_err_t crypto_init(void);

/**
 * Load the device key from its stored form, or generate a new one.
 *
 * The key is stored as the raw 32-byte private scalar.
 *
 * @param private_key The stored scalar, or NULL to generate a new key.
 */
esp_err_t crypto_load_or_create(const uint8_t *private_key);

/**
 * The private key, as the raw 32-byte scalar, for storing in NVS.
 */
esp_err_t crypto_export_private_key(uint8_t *out, size_t out_len);

/**
 * The public key as the raw uncompressed point (65 bytes).
 *
 * @param out     The output buffer.
 * @param out_len The buffer size on entry, the length written on exit.
 */
esp_err_t crypto_export_public_point(uint8_t *out, size_t *out_len);

/**
 * Sign a message.
 *
 * The message is hashed with SHA-256 and signed with ECDSA P-256. The
 * result is a DER-encoded signature, which is what the server verifies.
 *
 * @param message     The message to sign.
 * @param message_len The message length.
 * @param out         The output buffer, at least 80 bytes.
 * @param out_len     The buffer size on entry, the length written on exit.
 */
esp_err_t crypto_sign(const uint8_t *message, size_t message_len, uint8_t *out, size_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* CRYPTO_H */

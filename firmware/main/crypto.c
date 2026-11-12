/*
 * Device identity and request signing.
 *
 * The device holds an ECDSA P-256 key pair. The private key never leaves
 * the device; the server stores the public key and verifies signatures
 * against it.
 *
 * Why the low-level mbedTLS API
 * ----------------------------
 *
 * The obvious implementation uses PSA Crypto: import a key, then
 * psa_sign_hash(). That does not work on this chip with ESP-IDF v6.
 * psa_sign_hash() fails with PSA_ERROR_INVALID_HANDLE for every key, even
 * one that psa_generate_key() created moments earlier, and even though
 * psa_export_public_key() on the same key succeeds.
 *
 * The underlying cryptography is fine: mbedtls_ecdsa_sign() succeeds, and
 * so do mbedtls_ecp_group_load(), mbedtls_ecp_point_write_binary() and
 * mbedtls_ecp_read_key(). The failure is in PSA's key-slot layer, and
 * mbedTLS's public-key API is built on top of that same layer, so it
 * cannot be used either.
 *
 * So the key is held as an mbedtls_ecp_keypair and signed directly. The
 * key material is the raw 32-byte private scalar, which is also what the
 * server-side verifier needs in order to derive the public point.
 */

#include <string.h>

#include "esp_log.h"
#include "mbedtls/bignum.h"
#include "mbedtls/ecp.h"
#include "mbedtls/md.h"
#include "mbedtls/private/ecdsa.h"
#include "psa/crypto.h"

#include "crypto.h"

static const char *TAG = "crypto";

/* The size of a P-256 scalar. */
#define P256_SCALAR_BYTES 32

/* A DER-encoded ECDSA signature for P-256 is at most 72 bytes: two
 * integers of up to 33 bytes each, plus their tags and lengths. */
#define DER_SIGNATURE_MAX 80

/**
 * The device's key.
 */
static mbedtls_ecp_keypair s_key;
static bool s_key_present = false;

/**
 * A random source for mbedTLS, backed by PSA.
 *
 * mbedTLS 3.6 keeps the classic entropy module private, so the hardware
 * random source is reached through PSA instead.
 */
static int psa_random_getter(void *ctx, unsigned char *out, size_t len) {
    (void)ctx;

    psa_status_t status = psa_generate_random(out, len);
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "The random source failed: %ld", (long)status);
        return -1;
    }
    return 0;
}

/**
 * Convert a raw `r || s` signature into DER.
 *
 * The DER encoding of an ECDSA signature is a SEQUENCE of two INTEGERs:
 *
 *     SEQUENCE {
 *         INTEGER r,
 *         INTEGER s,
 *     }
 *
 * Each integer is minimally encoded. A leading zero byte is added when the
 * high bit of the value is set, so that the value is not read as negative.
 * Lengths below 128 are written as a single byte, which is all we need
 * here: the integers are at most 33 bytes long.
 *
 * @param raw     The raw signature, 64 bytes: r then s, each 32 bytes.
 * @param out     The DER output buffer.
 * @param out_len The output buffer size on entry, the length written on exit.
 *
 * @return true on success.
 */
static bool raw_to_der(const uint8_t *raw, uint8_t *out, size_t *out_len) {
    const size_t scalar_len = P256_SCALAR_BYTES;

    /* The number of value bytes each integer occupies.
     *
     * A leading zero byte is needed when the high bit of the value is set,
     * because otherwise the value would be read as a negative number. */
    const size_t r_value_len = (raw[0] & 0x80) != 0 ? scalar_len + 1 : scalar_len;
    const size_t s_value_len = (raw[scalar_len] & 0x80) != 0 ? scalar_len + 1 : scalar_len;

    /* The sequence's contents: each integer is a tag, a length, and the
     * value itself. */
    const size_t contents_len = (2 + r_value_len) + (2 + s_value_len);
    const size_t total_len = 2 + contents_len;

    if (*out_len < total_len) {
        return false;
    }

    size_t o = 0;

    /* The SEQUENCE header. */
    out[o++] = 0x30;
    out[o++] = (uint8_t)contents_len;

    /* The two INTEGERs. */
    for (int which = 0; which < 2; which++) {
        const uint8_t *value = raw + (which == 0 ? 0 : scalar_len);
        const size_t value_len = which == 0 ? r_value_len : s_value_len;

        out[o++] = 0x02; /* INTEGER */
        /* The length counts the value bytes only, not the tag or the
         * length byte itself. */
        out[o++] = (uint8_t)value_len;

        if (value_len > scalar_len) {
            out[o++] = 0x00; /* the sign byte */
        }
        memcpy(out + o, value, scalar_len);
        o += scalar_len;
    }

    *out_len = o;
    return true;
}

/**
 * Check that the crypto subsystem is usable.
 *
 * ESP-IDF already calls psa_crypto_init() during system start-up, before
 * app_main runs. Calling it a second time resets the key slots, which
 * would silently destroy any key that has been imported, so it must not be
 * called again.
 */
esp_err_t crypto_init(void) {
    uint8_t probe = 0;
    psa_status_t status = psa_generate_random(&probe, sizeof(probe));
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "The random source is not working: %ld", (long)status);
        return ESP_FAIL;
    }

    mbedtls_ecp_keypair_init(&s_key);

    ESP_LOGI(TAG, "The crypto module is ready");
    return ESP_OK;
}

/**
 * Load the device key from its stored form, or generate a new one.
 *
 * The key is stored as the raw 32-byte private scalar.
 *
 * @param private_key The stored scalar, or NULL to generate a new key.
 */
esp_err_t crypto_load_or_create(const uint8_t *private_key) {
    mbedtls_ecp_keypair_init(&s_key);

    int result = mbedtls_ecp_group_load(&s_key.MBEDTLS_PRIVATE(grp), MBEDTLS_ECP_DP_SECP256R1);
    if (result != 0) {
        ESP_LOGE(TAG, "Could not load the P-256 group: %d", result);
        return ESP_FAIL;
    }

    if (private_key != NULL) {
        result = mbedtls_mpi_read_binary(&s_key.MBEDTLS_PRIVATE(d), private_key, P256_SCALAR_BYTES);
        if (result != 0) {
            ESP_LOGE(TAG, "Could not read the stored key: %d", result);
            return ESP_FAIL;
        }
    } else {
        result = mbedtls_ecp_gen_privkey(&s_key.MBEDTLS_PRIVATE(grp), &s_key.MBEDTLS_PRIVATE(d),
                                          psa_random_getter, NULL);
        if (result != 0) {
            ESP_LOGE(TAG, "Could not generate a key: %d", result);
            return ESP_FAIL;
        }
    }

    result = mbedtls_ecp_check_privkey(&s_key.MBEDTLS_PRIVATE(grp), &s_key.MBEDTLS_PRIVATE(d));
    if (result != 0) {
        ESP_LOGE(TAG, "The private key is not valid: %d", result);
        return ESP_FAIL;
    }

    s_key_present = true;
    if (private_key != NULL) {
        ESP_LOGI(TAG, "Loaded the device key from storage");
    } else {
        ESP_LOGI(TAG, "Generated a new device key");
    }
    return ESP_OK;
}

/**
 * The private key, as the raw 32-byte scalar, for storing in NVS.
 *
 * @param out The output buffer, at least 32 bytes.
 */
esp_err_t crypto_export_private_key(uint8_t *out, size_t out_len) {
    if (!s_key_present || out_len < P256_SCALAR_BYTES) {
        return ESP_FAIL;
    }

    int result = mbedtls_mpi_write_binary(&s_key.MBEDTLS_PRIVATE(d), out, P256_SCALAR_BYTES);
    if (result != 0) {
        ESP_LOGE(TAG, "Could not export the private key: %d", result);
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * The public key as the raw uncompressed point.
 *
 * @param out     The output buffer, at least 65 bytes.
 * @param out_len The buffer size on entry, the length written on exit.
 */
esp_err_t crypto_export_public_point(uint8_t *out, size_t *out_len) {
    if (!s_key_present) {
        return ESP_FAIL;
    }

    /* The public point is derived from the private scalar: Q = d * G.
     *
     * mbedtls_ecp_muladd computes R = m*P + n*Q, so passing the generator
     * as P, a zero multiplier for it and the private scalar as the second
     * term gives d*G. */
    if (mbedtls_ecp_is_zero(&s_key.MBEDTLS_PRIVATE(Q))) {
        mbedtls_mpi zero;
        mbedtls_mpi_init(&zero);
        mbedtls_mpi_lset(&zero, 0);

        int result = mbedtls_ecp_muladd(&s_key.MBEDTLS_PRIVATE(grp), &s_key.MBEDTLS_PRIVATE(Q),
                                        &zero, &s_key.MBEDTLS_PRIVATE(grp).G,
                                        &s_key.MBEDTLS_PRIVATE(d), &s_key.MBEDTLS_PRIVATE(grp).G);
        mbedtls_mpi_free(&zero);

        if (result != 0) {
            ESP_LOGE(TAG, "Could not derive the public key: %d", result);
            return ESP_FAIL;
        }
    }

    size_t written = 0;
    int result = mbedtls_ecp_point_write_binary(&s_key.MBEDTLS_PRIVATE(grp),
                                               &s_key.MBEDTLS_PRIVATE(Q), MBEDTLS_ECP_PF_UNCOMPRESSED,
                                               &written, out, *out_len);
    if (result != 0) {
        ESP_LOGE(TAG, "Could not export the public key: %d", result);
        return ESP_FAIL;
    }

    *out_len = written;
    return ESP_OK;
}

/**
 * Sign a message.
 *
 * The message is hashed with SHA-256 and signed with ECDSA. The raw
 * `r || s` signature is converted to DER, which is what the server
 * verifies.
 *
 * @param message     The message to sign.
 * @param message_len The message length.
 * @param out         The output buffer, at least DER_SIGNATURE_MAX bytes.
 * @param out_len     The buffer size on entry, the length written on exit.
 */
esp_err_t crypto_sign(const uint8_t *message, size_t message_len, uint8_t *out, size_t *out_len) {
    if (!s_key_present) {
        return ESP_FAIL;
    }

    /* Hash with PSA: mbedTLS 3.6 keeps the classic hash modules private,
     * but the hashing itself works perfectly well through PSA. */
    uint8_t hash[32];
    size_t hash_len = 0;
    psa_status_t hash_status =
        psa_hash_compute(PSA_ALG_SHA_256, message, message_len, hash, sizeof(hash), &hash_len);
    if (hash_status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Could not hash the message: %ld", (long)hash_status);
        return ESP_FAIL;
    }

    mbedtls_mpi r;
    mbedtls_mpi s;
    mbedtls_mpi_init(&r);
    mbedtls_mpi_init(&s);

    int result = mbedtls_ecdsa_sign(&s_key.MBEDTLS_PRIVATE(grp), &r, &s, &s_key.MBEDTLS_PRIVATE(d),
                                    hash, sizeof(hash), psa_random_getter, NULL);
    if (result != 0) {
        ESP_LOGE(TAG, "Could not sign: %d", result);
        mbedtls_mpi_free(&r);
        mbedtls_mpi_free(&s);
        return ESP_FAIL;
    }

    /* The raw signature is the two scalars, big-endian. */
    uint8_t raw[2 * P256_SCALAR_BYTES];
    result = mbedtls_mpi_write_binary(&r, raw, P256_SCALAR_BYTES);
    if (result == 0) {
        result = mbedtls_mpi_write_binary(&s, raw + P256_SCALAR_BYTES, P256_SCALAR_BYTES);
    }

    mbedtls_mpi_free(&r);
    mbedtls_mpi_free(&s);

    if (result != 0) {
        ESP_LOGE(TAG, "Could not read the signature: %d", result);
        return ESP_FAIL;
    }

    size_t der_len = *out_len;
    if (!raw_to_der(raw, out, &der_len)) {
        ESP_LOGE(TAG, "Could not DER-encode the signature");
        return ESP_FAIL;
    }

    *out_len = der_len;
    return ESP_OK;
}

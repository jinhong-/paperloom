/*
 * Device identity and request signing.
 *
 * The device holds an ECDSA P-256 key pair. The private key never leaves
 * the device; the server stores the public key and verifies signatures
 * against it.
 *
 * The implementation uses PSA Crypto, which is the API mbedTLS 3.6 (as
 * shipped with ESP-IDF v6) exposes. PSA produces a raw `r || s`
 * signature, which we convert to the DER encoding that the server's
 * `node:crypto` verifier expects.
 */

#include <string.h>

#include "esp_log.h"
#include "psa/crypto.h"
#include "psa/crypto_sizes.h"

#include "crypto.h"

static const char *TAG = "crypto";

/* The size of a P-256 scalar. */
#define P256_SCALAR_BYTES 32

/* A DER-encoded ECDSA signature for P-256 is at most 72 bytes: two
 * integers of up to 33 bytes each, plus their tags and lengths. */
#define DER_SIGNATURE_MAX 80

/**
 * The device's key, held in a PSA key slot.
 */
static psa_key_id_t s_key_id = 0;
static bool s_key_present = false;

/**
 * Convert a raw `r || s` signature into DER.
 *
 * The DER encoding of an ECDSA signature is a SEQUENCE of two INTEGERs.
 * Each integer is minimally encoded: a leading zero byte is added when the
 * high bit is set, so that the value is not read as negative.
 *
 * @param raw     The raw signature, 64 bytes.
 * @param out     The DER output buffer.
 * @param out_len The output buffer size; updated with the length written.
 *
 * @return true on success.
 */
static bool raw_to_der(const uint8_t *raw, uint8_t *out, size_t *out_len) {
    const size_t scalar_len = P256_SCALAR_BYTES;

    /* Work out the encoded length of each integer: a leading zero byte is
     * needed when the high bit of the value is set. */
    const size_t r_len = (raw[0] & 0x80) != 0 ? scalar_len + 1 : scalar_len;
    const size_t s_len = (raw[scalar_len] & 0x80) != 0 ? scalar_len + 1 : scalar_len;

    /* The sequence's contents: tag + length + value, twice. */
    const size_t contents_len = (2 + r_len) + (2 + s_len);
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
        const size_t encoded_len = which == 0 ? r_len : s_len;

        out[o++] = 0x02; /* INTEGER */
        out[o++] = (uint8_t)(encoded_len - 1); /* the length of the value */
        if (encoded_len > scalar_len) {
            out[o++] = 0x00; /* the sign byte */
        }
        memcpy(out + o, value, scalar_len);
        o += scalar_len;
    }

    *out_len = o;
    return true;
}

/**
 * Initialise the crypto module.
 */
esp_err_t crypto_init(void) {
    psa_status_t status = psa_crypto_init();
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "psa_crypto_init failed: %ld", (long)status);
        return ESP_FAIL;
    }
    return ESP_OK;
}

/**
 * Load the device key from its PEM representation, or generate one.
 *
 * @param pem The stored PEM key, or NULL to generate a new key.
 */
esp_err_t crypto_load_or_create(const char *pem) {
    if (pem != NULL && pem[0] != '\0') {
        psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
        psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
        psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH | PSA_KEY_USAGE_EXPORT);
        psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));

        psa_status_t status = psa_import_key(&attributes, (const uint8_t *)pem,
                                             strlen(pem) + 1, &s_key_id);
        psa_reset_key_attributes(&attributes);

        if (status != PSA_SUCCESS) {
            ESP_LOGE(TAG, "Failed to import the stored key: %ld", (long)status);
            return ESP_FAIL;
        }

        s_key_present = true;
        ESP_LOGI(TAG, "Loaded the device key from storage");
        return ESP_OK;
    }

    /* Generate a new key pair. */
    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_set_key_type(&attributes, PSA_KEY_TYPE_ECC_KEY_PAIR(PSA_ECC_FAMILY_SECP_R1));
    psa_set_key_usage_flags(&attributes, PSA_KEY_USAGE_SIGN_HASH | PSA_KEY_USAGE_EXPORT);
    psa_set_key_algorithm(&attributes, PSA_ALG_ECDSA(PSA_ALG_SHA_256));

    psa_status_t status = psa_generate_key(&attributes, &s_key_id);
    psa_reset_key_attributes(&attributes);

    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Failed to generate a key: %ld", (long)status);
        return ESP_FAIL;
    }

    s_key_present = true;
    ESP_LOGI(TAG, "Generated a new device key");
    return ESP_OK;
}

/**
 * Export the private key as PEM so it can be stored in NVS.
 *
 * @param out     The output buffer.
 * @param out_len The buffer size on entry, the length written on exit.
 */
esp_err_t crypto_export_private_pem(char *out, size_t *out_len) {
    if (!s_key_present) {
        return ESP_FAIL;
    }

    uint8_t buffer[1024];
    size_t written = 0;
    psa_status_t status = psa_export_key(s_key_id, buffer, sizeof(buffer), &written);

    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Failed to export the private key: %ld", (long)status);
        return ESP_FAIL;
    }

    if (written >= *out_len) {
        return ESP_ERR_NO_MEM;
    }

    memcpy(out, buffer, written);
    out[written] = '\0';
    *out_len = written;
    return ESP_OK;
}

/**
 * The public key, as the raw uncompressed point.
 *
 * @param out     The output buffer, at least 65 bytes.
 * @param out_len The buffer size on entry, the length written on exit.
 */
esp_err_t crypto_export_public_point(uint8_t *out, size_t *out_len) {
    if (!s_key_present) {
        return ESP_FAIL;
    }

    psa_key_attributes_t attributes = PSA_KEY_ATTRIBUTES_INIT;
    psa_get_key_attributes(s_key_id, &attributes);

    uint8_t buffer[PSA_EXPORT_KEY_OUTPUT_SIZE(PSA_KEY_TYPE_ECC_PUBLIC_KEY(PSA_ECC_FAMILY_SECP_R1), 256)];
    size_t written = 0;

    /* PSA exports the public key of a key pair in the standard
     * uncompressed form: a 0x04 tag followed by X and Y. */
    psa_status_t status = psa_export_public_key(s_key_id, buffer, sizeof(buffer), &written);
    psa_reset_key_attributes(&attributes);

    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Failed to export the public key: %ld", (long)status);
        return ESP_FAIL;
    }

    if (written > *out_len) {
        return ESP_ERR_NO_MEM;
    }

    memcpy(out, buffer, written);
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

    uint8_t hash[32];
    size_t hash_len = 0;
    psa_status_t status = psa_hash_compute(PSA_ALG_SHA_256, message, message_len, hash, sizeof(hash),
                                           &hash_len);
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Failed to hash the message: %ld", (long)status);
        return ESP_FAIL;
    }

    /* The raw signature is two 32-byte scalars. The size macro takes the
     * curve size in bits. */
    uint8_t raw[PSA_ECDSA_SIGNATURE_SIZE(256)];
    size_t raw_len = 0;

    status = psa_sign_hash(PSA_ALG_ECDSA(PSA_ALG_SHA_256), s_key_id, hash, sizeof(hash), raw,
                           sizeof(raw), &raw_len);
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "Failed to sign: %ld", (long)status);
        return ESP_FAIL;
    }

    size_t der_len = *out_len;
    if (!raw_to_der(raw, out, &der_len)) {
        ESP_LOGE(TAG, "Failed to DER-encode the signature");
        return ESP_FAIL;
    }

    *out_len = der_len;
    return ESP_OK;
}

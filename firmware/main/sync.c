/*
 * Syncing with the server.
 *
 * The device initiates every exchange. A sync is:
 *
 *   1. POST /api/device/sync with a signed body reporting the device's
 *      actual state.
 *   2. The server replies with the authoritative schedule window and a
 *      manifest of the assets the device is missing.
 *   3. The device downloads the missing assets, verifying each hash.
 *
 * Every request is signed with the device's ECDSA P-256 private key. The
 * signature covers the method, path, timestamp, nonce, device id and the
 * SHA-256 of the body, exactly as the server's auth/signing.ts builds it.
 */

#include <string.h>

#include "cJSON.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "nvs.h"
#include "psa/crypto.h"

#include "app_config.h"
#include "board.h"
#include "crypto.h"
#include "schedule.h"
#include "storage.h"
#include "sync.h"
#include "time.h"
#include "utils.h"

static const char *TAG = "sync";

#define NVS_NAMESPACE "paperloom"
#define NVS_KEY_NEXT_SYNC "next_sync"
#define NVS_KEY_SERVER_URL "server_url"
#define NVS_KEY_DEVICE_ID "device_id"
#define NVS_KEY_PRIVATE_KEY "priv_key"
#define NVS_KEY_PUBLIC_KEY "pub_key"

static char s_server_url[256] = {0};
static char s_device_id[64] = {0};
static char s_next_sync_at[40] = {0};

/* The two base64 alphabets: signatures use the URL-safe one, the public
 * key uses the standard one, because that is what the server decodes. */
static void base64url_encode(const uint8_t *data, size_t len, char *out, size_t out_len);
static void base64_encode(const uint8_t *data, size_t len, char *out, size_t out_len);

/**
 * Read a NVS string.
 */
static bool nvs_read_string(const char *key, char *out, size_t out_len) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }
    size_t len = out_len;
    esp_err_t err = nvs_get_str(nvs, key, out, &len);
    nvs_close(nvs);
    return err == ESP_OK;
}

/**
 * Write a NVS string.
 */
static bool nvs_write_string(const char *key, const char *value) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return false;
    }
    esp_err_t err = nvs_set_str(nvs, key, value);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);
    return err == ESP_OK;
}

/**
 * Read a NVS blob.
 */
static bool nvs_read_bytes(const char *key, uint8_t *out, size_t out_len) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return false;
    }
    size_t len = out_len;
    esp_err_t err = nvs_get_blob(nvs, key, out, &len);
    nvs_close(nvs);
    return err == ESP_OK && len == out_len;
}

/**
 * Write a NVS blob.
 */
static bool nvs_write_bytes(const char *key, const uint8_t *value, size_t len) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return false;
    }
    esp_err_t err = nvs_set_blob(nvs, key, value, len);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);
    return err == ESP_OK;
}

/**
 * Compute the SHA-256 of a buffer.
 */
static void sha256_hex(const uint8_t *data, size_t len, char *out_hex) {
    uint8_t digest[32];
    size_t digest_len = 0;

    psa_status_t status = psa_hash_compute(PSA_ALG_SHA_256, data, len, digest, sizeof(digest),
                                            &digest_len);
    if (status != PSA_SUCCESS) {
        /* A hash failure means the request cannot be signed, so fail
         * loudly rather than signing something wrong. */
        ESP_LOGE(TAG, "Failed to hash the request body: %ld", (long)status);
        memset(digest, 0, sizeof(digest));
    }

    for (int i = 0; i < 32; i++) {
        snprintf(out_hex + i * 2, 3, "%02x", digest[i]);
    }
    out_hex[64] = '\0';
}

/**
 * Generate a random nonce.
 *
 * The nonce is the replay guard, so it must be unpredictable. We use the
 * hardware RNG, which on the ESP32-S3 is backed by a true entropy source.
 */
static void generate_nonce(char *out, size_t out_len) {
    uint8_t bytes[16];
    esp_fill_random(bytes, sizeof(bytes));

    static const char hex[] = "0123456789abcdef";
    size_t n = sizeof(bytes) * 2;
    if (n > out_len - 1) {
        n = out_len - 1;
    }
    for (size_t i = 0; i < n; i++) {
        out[i] = hex[(bytes[i / 2] >> ((i % 2) * 4)) & 0x0f];
    }
    out[n] = '\0';
}

/**
 * Build the canonical string that gets signed.
 *
 * The field order must match the server exactly:
 *
 *   METHOD \n PATH \n TIMESTAMP \n NONCE \n DEVICE_ID \n BODY_SHA256
 */
static void build_canonical_string(const char *method, const char *path, int64_t timestamp,
                                   const char *nonce, const char *device_id,
                                   const char *body_digest, char *out, size_t out_len) {
    snprintf(out, out_len, "%s\n%s\n%lld\n%s\n%s\n%s", method, path, (long long)timestamp, nonce,
             device_id, body_digest);
}

/**
 * Sign the canonical string with the device's private key.
 *
 * The signature is DER-encoded ECDSA, base64url encoded, exactly as the
 * server expects.
 */
static bool sign_canonical(const char *canonical, char *out, size_t out_len) {
    uint8_t signature[80];
    size_t signature_len = sizeof(signature);

    if (crypto_sign((const uint8_t *)canonical, strlen(canonical), signature, &signature_len) !=
        ESP_OK) {
        return false;
    }

    base64url_encode(signature, signature_len, out, out_len);
    return true;
}

/**
 * Base64url-encode a buffer.
 */
static void base64url_encode(const uint8_t *data, size_t len, char *out, size_t out_len) {
    static const char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

    size_t o = 0;
    for (size_t i = 0; i < len && o + 4 < out_len; i += 3) {
        uint32_t chunk = (uint32_t)data[i] << 16;
        if (i + 1 < len) chunk |= (uint32_t)data[i + 1] << 8;
        if (i + 2 < len) chunk |= (uint32_t)data[i + 2];

        out[o++] = alphabet[(chunk >> 18) & 0x3f];
        out[o++] = alphabet[(chunk >> 12) & 0x3f];
        if (i + 1 < len) out[o++] = alphabet[(chunk >> 6) & 0x3f];
        if (i + 2 < len) out[o++] = alphabet[chunk & 0x3f];
    }
    out[o] = '\0';
}

/**
 * Load or create the device identity.
 *
 * The key is the raw 32-byte private scalar, stored in NVS. The public
 * key is sent to the server during enrollment; the private key never
 * leaves the device.
 */
static esp_err_t load_identity(void) {
    uint8_t scalar[CRYPTO_PRIVATE_KEY_BYTES];

    if (nvs_read_bytes(NVS_KEY_PRIVATE_KEY, scalar, sizeof(scalar))) {
        if (crypto_load_or_create(scalar) == ESP_OK) {
            return ESP_OK;
        }
        ESP_LOGW(TAG, "The stored key could not be used; generating a new one");
    }

    if (crypto_load_or_create(NULL) != ESP_OK) {
        return ESP_FAIL;
    }

    /* Store the new key so the identity survives a restart. */
    if (crypto_export_private_key(scalar, sizeof(scalar)) != ESP_OK) {
        ESP_LOGE(TAG, "Failed to export the private key");
        return ESP_FAIL;
    }
    if (!nvs_write_bytes(NVS_KEY_PRIVATE_KEY, scalar, sizeof(scalar))) {
        ESP_LOGE(TAG, "Failed to store the private key");
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * The public key, base64 encoded as the raw uncompressed point.
 *
 * The server stores this and verifies signatures against it.
 */
static bool export_public_key(char *out, size_t out_len) {
    uint8_t point[65];
    size_t point_len = sizeof(point);

    if (crypto_export_public_point(point, &point_len) != ESP_OK) {
        return false;
    }
    if (point_len != 65 || point[0] != 0x04) {
        ESP_LOGE(TAG, "The exported public key is not a valid uncompressed point");
        return false;
    }

    base64_encode(point, point_len, out, out_len);
    return true;
}

/**
 * Base64-encode a buffer using the standard alphabet.
 *
 * The server decodes the public key with Node's standard base64, so the
 * signature's URL-safe alphabet is not used here.
 */
static void base64_encode(const uint8_t *data, size_t len, char *out, size_t out_len) {
    static const char alphabet[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

    size_t o = 0;
    for (size_t i = 0; i < len && o + 4 < out_len; i += 3) {
        uint32_t chunk = (uint32_t)data[i] << 16;
        if (i + 1 < len) chunk |= (uint32_t)data[i + 1] << 8;
        if (i + 2 < len) chunk |= (uint32_t)data[i + 2];

        out[o++] = alphabet[(chunk >> 18) & 0x3f];
        out[o++] = alphabet[(chunk >> 12) & 0x3f];
        out[o++] = i + 1 < len ? alphabet[(chunk >> 6) & 0x3f] : '=';
        out[o++] = i + 2 < len ? alphabet[chunk & 0x3f] : '=';
    }
    out[o] = '\0';
}

esp_err_t sync_init(void) {
    nvs_read_string(NVS_KEY_SERVER_URL, s_server_url, sizeof(s_server_url));
    nvs_read_string(NVS_KEY_DEVICE_ID, s_device_id, sizeof(s_device_id));
    nvs_read_string(NVS_KEY_NEXT_SYNC, s_next_sync_at, sizeof(s_next_sync_at));

    /* The device needs an id even before it is set up, because the id is
     * part of the request signature. */
    esp_err_t err = sync_ensure_device_id();
    if (err != ESP_OK) {
        return err;
    }

    err = crypto_init();
    if (err != ESP_OK) {
        return err;
    }

    err = load_identity();
    if (err != ESP_OK) {
        return err;
    }
    if (s_server_url[0] == '\0') {
        ESP_LOGW(TAG, "No server URL configured; the device is not set up");
    }

    return ESP_OK;
}

bool sync_is_configured(void) {
    return s_server_url[0] != '\0' && s_device_id[0] != '\0';
}

/**
 * The claim code from the last enrolment, if there was one.
 */
static char s_claim_code[32] = {0};

/**
 * The claim URL from the last enrolment.
 */
static char s_claim_url[160] = {0};

/* Defined further down, but needed by the enrolment code above. */
static esp_err_t signed_request(const char *method, const char *path, const char *body,
                                 size_t body_len, char *out, size_t *out_len);

/**
 * Enrol with the server.
 *
 * The device sends its public key and gets a claim code back, which the
 * owner scans to make the frame theirs.
 *
 * @param claim_code The code that was issued, if any.
 * @param claim_url  The URL the claim QR code should point at.
 *
 * @return true on success.
 */
bool sync_enrol(char *claim_code, size_t claim_code_len, char *claim_url, size_t claim_url_len) {
    if (!sync_is_configured()) {
        ESP_LOGW(TAG, "Cannot enrol: the server URL is not set");
        return false;
    }

    char public_key[128];
    if (!export_public_key(public_key, sizeof(public_key))) {
        ESP_LOGE(TAG, "Could not export the public key");
        return false;
    }

    char body[512];
    int length = snprintf(body, sizeof(body),
                          "{\"device_id\":\"%s\",\"name\":\"Paperloom\","
                          "\"public_key\":\"%s\",\"panel_width\":%d,\"panel_height\":%d}",
                          s_device_id, public_key, PANEL_WIDTH, PANEL_HEIGHT);
    char response[2048];
    size_t response_len = sizeof(response);

    char path[64];
    snprintf(path, sizeof(path), "/api/device/enroll");

    if (signed_request("POST", path, body, (size_t)length, response, &response_len) != SYNC_OK) {
        return false;
    }

    cJSON *root = cJSON_Parse(response);
    if (root == NULL) {
        ESP_LOGE(TAG, "Could not parse the enrolment response: %s", response);
        return false;
    }

    cJSON *code = cJSON_GetObjectItem(root, "claim_code");
    cJSON *url = cJSON_GetObjectItem(root, "claim_url");

    bool ok = false;
    if (cJSON_IsString(code) && code->valuestring != NULL) {
        snprintf(s_claim_code, sizeof(s_claim_code), "%s", code->valuestring);
        if (claim_code != NULL && claim_code_len > 0) {
            snprintf(claim_code, claim_code_len, "%s", s_claim_code);
        }
        ok = true;
    }

    if (cJSON_IsString(url) && url->valuestring != NULL) {
        snprintf(s_claim_url, sizeof(s_claim_url), "%s", url->valuestring);
        if (claim_url != NULL && claim_url_len > 0) {
            snprintf(claim_url, claim_url_len, "%s", s_claim_url);
        }
    }

    /* Take the server's time. A device that has never synced has no
     * absolute time, so the timestamp it puts in a request would be
     * meaningless and the server would reject it. The enrolment response
     * carries the server's time, which anchors the clock; every later
     * request then carries a usable timestamp.
     *
     * This has to happen before the first sync, which is why the clock is
     * corrected here rather than from the sync response. */
    cJSON *server_time = cJSON_GetObjectItem(root, "server_time");
    if (cJSON_IsString(server_time) && server_time->valuestring != NULL) {
        int64_t server_ms = 0;
        if (parse_iso8601_ms(server_time->valuestring, &server_ms) == ESP_OK) {
            time_set_from_server(server_ms);
            ESP_LOGI(TAG, "The clock is now anchored to the server's time");
        }
    }

    cJSON_Delete(root);

    if (ok) {
        ESP_LOGI(TAG, "Enrolled; the claim code is %s", s_claim_code);
    }
    return ok;
}

/**
 * The claim code from the last enrolment.
 */
const char *sync_claim_code(void) {
    return s_claim_code;
}

/**
 * The claim URL from the last enrolment.
 */
const char *sync_claim_url(void) {
    return s_claim_url;
}

/**
 * Fetch the server's time and anchor the clock to it.
 *
 * A device that has never synced has no absolute time: the RTC comes up
 * with a meaningless value, and the timestamp in a signed request would be
 * rejected by the server. Fetching the time first is what makes the first
 * request possible.
 *
 * @return true if the clock was anchored.
 */
bool sync_fetch_server_time(void) {
    if (!sync_is_configured()) {
        return false;
    }

    /* The path has to be appended to the server URL: the URL on its own
     * is the root of the server, not the endpoint that gives the time. */
    char url[512];
    snprintf(url, sizeof(url), "%s%s", s_server_url, "/api/device/time");

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
        .cert_pem = board_ca_certificate(),
        .use_global_ca_store = board_ca_certificate() == NULL,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ESP_LOGW(TAG, "Could not create the HTTP client for the time request");
        return false;
    }

    char response[256];
    bool ok = false;

    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not open %s: %s", url, esp_err_to_name(err));
    } else {
        esp_http_client_fetch_headers(client);
        int read = esp_http_client_read_response(client, response, sizeof(response) - 1);
        if (read <= 0) {
            ESP_LOGW(TAG, "The time request returned no body");
        } else {
            response[read] = '\0';

            cJSON *root = cJSON_Parse(response);
            if (root == NULL) {
                ESP_LOGE(TAG, "Could not parse the time response: %s", response);
            } else {
                cJSON *server_time = cJSON_GetObjectItem(root, "server_time");
                int64_t server_ms = 0;
                if (cJSON_IsString(server_time) && server_time->valuestring != NULL &&
                    parse_iso8601_ms(server_time->valuestring, &server_ms) == ESP_OK) {
                    time_set_from_server(server_ms);
                    ok = true;
                } else {
                    ESP_LOGE(TAG, "The time response had no usable server_time: %s", response);
                }
                cJSON_Delete(root);
            }
        }
        esp_http_client_close(client);
    }

    esp_http_client_cleanup(client);
    return ok;
}

/**
 * Store the server URL and device id.
 */
esp_err_t sync_configure(const char *server_url, const char *device_id) {
    snprintf(s_server_url, sizeof(s_server_url), "%s", server_url);
    snprintf(s_device_id, sizeof(s_device_id), "%s", device_id);

    if (!nvs_write_string(NVS_KEY_SERVER_URL, s_server_url) ||
        !nvs_write_string(NVS_KEY_DEVICE_ID, s_device_id)) {
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * The server URL that is stored, or an empty string.
 */
const char *sync_server_url(void) {
    return s_server_url;
}

/**
 * The device id that is stored, or an empty string.
 */
const char *sync_device_id(void) {
    return s_device_id;
}

/**
 * Store the server URL.
 */
esp_err_t sync_set_server_url(const char *url) {
    snprintf(s_server_url, sizeof(s_server_url), "%s", url);
    if (!nvs_write_string(NVS_KEY_SERVER_URL, s_server_url)) {
        return ESP_FAIL;
    }
    return ESP_OK;
}

/**
 * Ensure the device has an id, generating one if it does not.
 *
 * The id is what the server knows the frame by. It is generated on the
 * frame rather than by the server so that the two can never disagree
 * about it.
 */
esp_err_t sync_ensure_device_id(void) {
    if (s_device_id[0] != '\0') {
        return ESP_OK;
    }

    uint8_t random[6];
    esp_fill_random(random, sizeof(random));

    char id[32];
    int offset = snprintf(id, sizeof(id), "frame-");
    for (size_t i = 0; i < sizeof(random) && offset < (int)sizeof(id) - 3; i++) {
        offset += snprintf(id + offset, sizeof(id) - (size_t)offset, "%02x", random[i]);
    }

    snprintf(s_device_id, sizeof(s_device_id), "%s", id);
    if (!nvs_write_string(NVS_KEY_DEVICE_ID, s_device_id)) {
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "The device id is %s", s_device_id);
    return ESP_OK;
}

/**
 * The device's public key, for the enrollment request.
 */
bool sync_public_key_base64(char *out, size_t out_len) {
    return export_public_key(out, out_len);
}

/**
 * Whether a sync is due.
 *
 * Before the first successful sync we do not know when to check in, so we
 * sync on every wake. After that we use the server's `next_sync_at`.
 */
bool sync_is_due(const int64_t *now_ms) {
    if (!sync_is_configured()) {
        return false;
    }

    if (s_next_sync_at[0] == '\0') {
        return true;
    }

    int64_t next = 0;
    if (parse_iso8601_ms(s_next_sync_at, &next) != ESP_OK) {
        return true;
    }

    return *now_ms >= next;
}

/**
 * The time at which the device should next wake to sync.
 */
bool sync_next_wake(const int64_t *now_ms, int64_t *wake_ms) {
    if (!sync_is_configured()) {
        return false;
    }

    if (s_next_sync_at[0] == '\0') {
        /* No instruction yet: check in on the next wake. */
        *wake_ms = *now_ms + 60000;
        return true;
    }

    int64_t next = 0;
    if (parse_iso8601_ms(s_next_sync_at, &next) != ESP_OK) {
        *wake_ms = *now_ms + 60000;
        return true;
    }

    *wake_ms = next;
    return true;
}

/**
 * Send a signed request and read the response.
 *
 * @param method   The HTTP method.
 * @param path     The path including any query string.
 * @param body     The request body, or NULL for none.
 * @param out      The response body; the buffer must be large enough.
 * @param out_len  The buffer size on entry, the response length on exit.
 */
static esp_err_t signed_request(const char *method, const char *path, const char *body,
                                 size_t body_len, char *out, size_t *out_len) {
    char url[512];
    snprintf(url, sizeof(url), "%s%s", s_server_url, path);

    char nonce[33];
    generate_nonce(nonce, sizeof(nonce));

    int64_t now_ms = 0;
    time_now(&now_ms);
    int64_t timestamp = now_ms;

    char body_digest[65];
    sha256_hex((const uint8_t *)(body ? body : ""), body ? body_len : 0, body_digest);

    char canonical[1024];
    build_canonical_string(method, path, timestamp, nonce, s_device_id, body_digest, canonical,
                           sizeof(canonical));

    char signature[256];
    if (!sign_canonical(canonical, signature, sizeof(signature))) {
        ESP_LOGE(TAG, "Failed to sign the request");
        return ESP_FAIL;
    }

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
        .cert_pem = board_ca_certificate(),
        .use_global_ca_store = board_ca_certificate() == NULL,
        .skip_cert_common_name_check = false,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        ESP_LOGE(TAG, "Failed to create the HTTP client");
        return ESP_FAIL;
    }

    esp_http_client_set_header(client, "Content-Type", "application/json");
    esp_http_client_set_header(client, "X-Paperloom-Device", s_device_id);
    esp_http_client_set_header(client, "X-Paperloom-Timestamp", StringifyInt(timestamp));
    esp_http_client_set_header(client, "X-Paperloom-Nonce", nonce);
    esp_http_client_set_header(client, "X-Paperloom-Signature", signature);

    /* The request has to be sent, and the response read, in a specific
     * order: open the connection with the length of the body, write the
     * body, read the response headers, then read the response body.
     *
     * esp_http_client_perform() does the whole exchange at once and
     * consumes the body, so it cannot be used when the response is
     * needed. The device needs the response: it carries the claim code
     * and the schedule.
     */
    size_t write_len = (body != NULL && body[0] != '\0') ? body_len : 0;
    esp_err_t err = esp_http_client_open(client, (int)write_len);

    int status = 0;
    size_t received = 0;
    size_t capacity = *out_len;

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not open the connection: %s", esp_err_to_name(err));
    } else {
        if (write_len > 0) {
            int written = esp_http_client_write(client, body, (int)write_len);
            if (written < 0) {
                ESP_LOGW(TAG, "Could not write the request body");
            }
        }

        int64_t expected = esp_http_client_fetch_headers(client);
        if (expected < 0) {
            ESP_LOGW(TAG, "Could not read the response headers");
        } else {
            int read = esp_http_client_read_response(client, out, (int)capacity);
            if (read < 0) {
                ESP_LOGW(TAG, "Could not read the response");
            } else {
                received = (size_t)read;
                if (received < capacity) {
                    out[received] = '\0';
                }
                *out_len = received;
            }
        }

        status = esp_http_client_get_status_code(client);
        esp_http_client_close(client);
    }

    esp_http_client_cleanup(client);

    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Request to %s failed: %s", path, esp_err_to_name(err));
        return ESP_FAIL;
    }

    if (status != 200) {
        ESP_LOGW(TAG, "Request to %s returned %d", path, status);
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * Compute the SHA-256 of a file, as a hex string.
 *
 * @param path     The file to hash.
 * @param out_hex  The output buffer, at least 65 bytes.
 *
 * @return true on success.
 */
static bool hash_file(const char *path, char *out_hex) {
    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        return false;
    }

    psa_hash_operation_t operation = PSA_HASH_OPERATION_INIT;
    if (psa_hash_setup(&operation, PSA_ALG_SHA_256) != PSA_SUCCESS) {
        fclose(f);
        return false;
    }

    uint8_t buffer[1024];
    size_t read = 0;
    while ((read = fread(buffer, 1, sizeof(buffer), f)) > 0) {
        if (psa_hash_update(&operation, buffer, read) != PSA_SUCCESS) {
            psa_hash_abort(&operation);
            fclose(f);
            return false;
        }
    }
    fclose(f);

    uint8_t digest[32];
    size_t digest_len = 0;
    if (psa_hash_finish(&operation, digest, sizeof(digest), &digest_len) != PSA_SUCCESS) {
        return false;
    }

    for (int i = 0; i < 32; i++) {
        snprintf(out_hex + i * 2, 3, "%02x", digest[i]);
    }
    out_hex[64] = '\0';
    return true;
}

/**
 * Build the body of a sync request.
 *
 * The body reports the device's actual state: which asset is on the panel,
 * which assets it holds, its battery voltage and its firmware version.
 */
static char *build_sync_body(size_t *out_len) {
    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return NULL;
    }

    cJSON_AddStringToObject(root, "device_id", s_device_id);

    const char *revision = schedule_revision();
    if (revision != NULL && revision[0] != '\0') {
        cJSON_AddStringToObject(root, "schedule_revision", revision);
    }

    const char *displayed = schedule_displayed_asset();
    if (displayed != NULL && displayed[0] != '\0') {
        cJSON_AddStringToObject(root, "displayed_asset", displayed);
    }

    /* Tell the server what we already hold so it only sends what is
     * missing. */
    cJSON *cached = cJSON_AddArrayToObject(root, "cached_assets");
    if (cached != NULL) {
        size_t count = schedule_event_count();
        for (size_t i = 0; i < count; i++) {
            const char *hash = schedule_asset_at(i);
            if (hash != NULL && storage_has_asset(hash)) {
                cJSON_AddItemToArray(cached, cJSON_CreateString(hash));
            }
        }
    }

    int battery_mv = board_read_battery_mv();
    if (battery_mv > 0) {
        cJSON_AddNumberToObject(root, "battery_mv", battery_mv);
    }

    /* Tell the server what kind of power the frame is on.
     *
     * A frame on battery cannot afford to spend a lot of power on the
     * radio, so the server can be more careful about how much it asks it
     * to download. */
    cJSON_AddNumberToObject(root, "on_battery", board_is_on_battery() ? 1 : 0);

    cJSON_AddStringToObject(root, "firmware_version", APP_VERSION);
    cJSON_AddStringToObject(root, "wake_reason", "timer");

    /* Report the clock so the server can see whether the device's time is
     * trustworthy. A device whose clock has been lost, or that is running
     * far out of step, says so here rather than silently showing the wrong
     * photos at the wrong times. */
    cJSON_AddNumberToObject(root, "clock_ms", (double)time_now_ms());
    cJSON_AddNumberToObject(root, "clock_anchored", time_is_valid() ? 1 : 0);

    char *body = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);

    if (body != NULL) {
        *out_len = strlen(body);
    }
    return body;
}

/**
 * Perform a sync.
 */
sync_result_t sync_perform(const int64_t *now_ms) {
    (void)now_ms;

    if (!sync_is_configured()) {
        ESP_LOGW(TAG, "The device is not configured; skipping the sync");
        return SYNC_ERROR;
    }

    if (!board_wifi_connected()) {
        ESP_LOGW(TAG, "No network; skipping the sync");
        return SYNC_ERROR;
    }

    size_t body_len = 0;
    char *body = build_sync_body(&body_len);
    if (body == NULL) {
        return SYNC_ERROR;
    }

    ESP_LOGI(TAG, "Syncing with %s", s_server_url);

    char *response = malloc(32 * 1024);
    if (response == NULL) {
        free(body);
        return SYNC_ERROR;
    }

    size_t response_len = 32 * 1024;
    esp_err_t err = signed_request("POST", "/api/device/sync", body, body_len, response,
                                   &response_len);
    free(body);

    if (err != ESP_OK) {
        free(response);
        return SYNC_ERROR;
    }

    sync_result_t result = process_sync_response(response, response_len);

    free(response);
    return result;
}

/**
 * Parse the server's sync response.
 *
 * The response carries the new schedule window and the manifest of assets
 * we are missing. The schedule is stored first, then the assets are
 * downloaded.
 */
sync_result_t process_sync_response(const char *json, size_t len) {
    cJSON *root = cJSON_Parse(json);
    if (root == NULL) {
        ESP_LOGE(TAG, "Failed to parse the sync response");
        return SYNC_ERROR;
    }

    /* Anchor the clock to the server's time. This happens before the
     * schedule is stored, so the events are interpreted against a
     * corrected clock. */
    cJSON *server_time = cJSON_GetObjectItem(root, "server_time");
    if (cJSON_IsString(server_time) && server_time->valuestring != NULL) {
        int64_t server_ms = 0;
        if (parse_iso8601_ms(server_time->valuestring, &server_ms) == ESP_OK) {
            time_set_from_server(server_ms);
        }
    }

    /* Remember when to check in next. */
    cJSON *next_sync = cJSON_GetObjectItem(root, "next_sync_at");
    if (cJSON_IsString(next_sync) && next_sync->valuestring != NULL) {
        snprintf(s_next_sync_at, sizeof(s_next_sync_at), "%s", next_sync->valuestring);
        nvs_write_string(NVS_KEY_NEXT_SYNC, s_next_sync_at);
    }

    /* Store the schedule. The server sends the whole schedule object, so
     * we rebuild it from the response's "schedule" member. */
    cJSON *schedule = cJSON_GetObjectItem(root, "schedule");
    if (cJSON_IsObject(schedule)) {
        char *schedule_json = cJSON_PrintUnformatted(schedule);
        if (schedule_json != NULL) {
            esp_err_t err = schedule_replace(schedule_json, strlen(schedule_json));
            free(schedule_json);
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "Failed to store the new schedule");
                cJSON_Delete(root);
                return SYNC_ERROR;
            }
        }
    }

    /* Download the assets we are missing. */
    cJSON *assets = cJSON_GetObjectItem(root, "assets");
    if (cJSON_IsObject(assets)) {
        cJSON *entry = NULL;
        cJSON_ArrayForEach(entry, assets) {
            if (!cJSON_IsObject(entry)) {
                continue;
            }
            cJSON *hash_item = cJSON_GetObjectItem(entry, "sha256");
            if (!cJSON_IsString(hash_item) || hash_item->valuestring == NULL) {
                continue;
            }
            const char *hash = hash_item->valuestring;
            if (storage_has_asset(hash)) {
                continue;
            }
            if (sync_download_asset(hash) != SYNC_OK) {
                ESP_LOGW(TAG, "Could not download asset %s; it will be retried later", hash);
            }
        }
    }

    cJSON_Delete(root);
    return SYNC_OK;
}

/**
 * Download an asset and store it in the cache.
 *
 * The download is staged, the hash is verified, and only then is the file
 * committed. An interrupted or corrupt download never becomes a cached
 * asset.
 */
sync_result_t sync_download_asset(const char *hash) {
    if (!sync_is_configured()) {
        return SYNC_ERROR;
    }

    char staged_path[256];
    esp_err_t err = storage_begin_staging(hash, staged_path, sizeof(staged_path));
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "Could not start staging %s: %s", hash, esp_err_to_name(err));
        return SYNC_ERROR;
    }

    char url[512];
    snprintf(url, sizeof(url), "%s/api/device/assets/%s", s_server_url, hash);

    esp_http_client_config_t config = {
        .url = url,
        .method = HTTP_METHOD_GET,
        .timeout_ms = SYNC_HTTP_TIMEOUT_MS,
        .cert_pem = board_ca_certificate(),
        .use_global_ca_store = board_ca_certificate() == NULL,
    };

    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (client == NULL) {
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    /* The asset request is signed too, so the server can authorise it the
     * same way as the sync. */
    char nonce[33];
    generate_nonce(nonce, sizeof(nonce));
    int64_t now_ms = 0;
    time_now(&now_ms);
    char body_digest[65];
    sha256_hex((const uint8_t *)"", 0, body_digest);

    char path_with_query[512];
    snprintf(path_with_query, sizeof(path_with_query), "/api/device/assets/%s", hash);

    char canonical[1024];
    build_canonical_string("GET", path_with_query, now_ms, nonce, s_device_id, body_digest,
                           canonical, sizeof(canonical));

    char signature[256];
    if (!sign_canonical(canonical, signature, sizeof(signature))) {
        esp_http_client_cleanup(client);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    esp_http_client_set_header(client, "X-Paperloom-Device", s_device_id);
    esp_http_client_set_header(client, "X-Paperloom-Timestamp", StringifyInt(now_ms));
    esp_http_client_set_header(client, "X-Paperloom-Nonce", nonce);
    esp_http_client_set_header(client, "X-Paperloom-Signature", signature);

    /* The body has to be read between opening the connection and closing
     * it: esp_http_client_perform() consumes it. */
    esp_err_t perform = esp_http_client_open(client, 0);
    if (perform != ESP_OK) {
        ESP_LOGW(TAG, "Could not open the connection for %s", hash);
        esp_http_client_cleanup(client);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    int64_t expected = esp_http_client_fetch_headers(client);
    if (expected < 0) {
        ESP_LOGW(TAG, "Could not read the response headers for %s: %lld", hash,
                 (long long)expected);
    }
    /* Stream the body to the staging file. */
    FILE *f = fopen(staged_path, "wb");
    if (f == NULL) {
        ESP_LOGW(TAG, "Could not open %s for writing: %s", staged_path, strerror(errno));
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    uint8_t buffer[1024];
    int total = 0;
    while (true) {
        int len = esp_http_client_read(client, (char *)buffer, sizeof(buffer));
        if (len <= 0) {
            break;
        }
        total += len;
        if (total > SYNC_MAX_ASSET_BYTES) {
            ESP_LOGW(TAG, "Asset %s is too large", hash);
            fclose(f);
            esp_http_client_close(client);
            esp_http_client_cleanup(client);
            storage_abort_staging(staged_path);
            return SYNC_ERROR;
        }
        fwrite(buffer, 1, len, f);

        if (expected > 0 && total >= expected) {
            break;
        }
    }

    if (total == 0) {
        ESP_LOGW(TAG, "The download of %s returned no data", hash);
    }

    fflush(f);
    fsync(fileno(f));
    fclose(f);

    esp_http_client_close(client);

    int status = esp_http_client_get_status_code(client);
    esp_http_client_cleanup(client);

    if (status != 200) {
        ESP_LOGW(TAG, "Download of %s returned %d", hash, status);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    ESP_LOGI(TAG, "Downloaded %d bytes of asset %s", total, hash);

    /* Verify the hash. The asset's identity is its content, so a mismatch
     * means the download is unusable. The file is re-read to compute it,
     * which keeps the download path free of an incremental hash state. */
    char computed[65];
    if (!hash_file(staged_path, computed)) {
        ESP_LOGW(TAG, "Could not hash the downloaded asset %s", hash);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    if (strcmp(computed, hash) != 0) {
        ESP_LOGW(TAG, "Asset %s failed its hash check: got %s", hash, computed);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    if (storage_commit_staging(hash, staged_path, NULL) != ESP_OK) {
        return SYNC_ERROR;
    }

    return SYNC_OK;
}

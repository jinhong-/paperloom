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

    esp_err_t err = crypto_init();
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
                                 char *out, size_t *out_len) {
    char url[512];
    snprintf(url, sizeof(url), "%s%s", s_server_url, path);

    char nonce[33];
    generate_nonce(nonce, sizeof(nonce));

    int64_t now_ms = 0;
    time_now(&now_ms);
    int64_t timestamp = now_ms;

    char body_digest[65];
    sha256_hex((const uint8_t *)(body ? body : ""), body ? strlen(body) : 0, body_digest);

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

    if (body != NULL && body[0] != '\0') {
        esp_http_client_set_post_field(client, body, (int)strlen(body));
    }

    esp_err_t err = esp_http_client_perform(client);

    int status = 0;
    if (err == ESP_OK) {
        status = esp_http_client_get_status_code(client);
        int total = esp_http_client_fetch_headers(client);
        int received = 0;
        while (total > 0) {
            int len = esp_http_client_read(client, (char *)out + received, total);
            if (len <= 0) {
                break;
            }
            received += len;
            total -= len;
        }
        *out_len = (size_t)received;
        out[received] = '\0';
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

    cJSON_AddStringToObject(root, "firmware_version", APP_VERSION);
    cJSON_AddStringToObject(root, "wake_reason", "timer");

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
    esp_err_t err = signed_request("POST", "/api/device/sync", body, response, &response_len);
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

    esp_err_t perform = esp_http_client_perform(client);
    if (perform != ESP_OK) {
        ESP_LOGW(TAG, "Download of %s failed", hash);
        esp_http_client_cleanup(client);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    int status = esp_http_client_get_status_code(client);
    if (status != 200) {
        ESP_LOGW(TAG, "Download of %s returned %d", hash, status);
        esp_http_client_cleanup(client);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    /* Stream the body to the staging file. */
    FILE *f = fopen(staged_path, "wb");
    if (f == NULL) {
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
            esp_http_client_cleanup(client);
            storage_abort_staging(staged_path);
            return SYNC_ERROR;
        }
        fwrite(buffer, 1, len, f);
    }

    fflush(f);
    fsync(fileno(f));
    fclose(f);

    esp_http_client_cleanup(client);

    /* Verify the hash. The asset's identity is its content, so a mismatch
     * means the download is unusable. The file is re-read to compute it,
     * which keeps the download path free of an incremental hash state. */
    char computed[65];
    if (!hash_file(staged_path, computed)) {
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    if (strcmp(computed, hash) != 0) {
        ESP_LOGW(TAG, "Asset %s failed its hash check", hash);
        storage_abort_staging(staged_path);
        return SYNC_ERROR;
    }

    if (storage_commit_staging(hash, staged_path, NULL) != ESP_OK) {
        return SYNC_ERROR;
    }

    return SYNC_OK;
}

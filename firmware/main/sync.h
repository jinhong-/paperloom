/*
 * Syncing with the server.
 */

#ifndef SYNC_H
#define SYNC_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    SYNC_OK,
    SYNC_ERROR,
} sync_result_t;

/**
 * Initialise the sync module: load the server URL, device id and identity.
 */
esp_err_t sync_init(void);

/**
 * Whether the device has enough configuration to talk to the server.
 */
bool sync_is_configured(void);

/**
 * Store the server URL and device id.
 */
esp_err_t sync_configure(const char *server_url, const char *device_id);

/**
 * The device's public key, base64url encoded as the raw point.
 *
 * Used during enrollment.
 */
bool sync_public_key_base64(char *out, size_t out_len);

/**
 * Whether a sync is due.
 */
bool sync_is_due(const int64_t *now_ms);

/**
 * The time at which the device should next wake to sync.
 */
bool sync_next_wake(const int64_t *now_ms, int64_t *wake_ms);

/**
 * Perform a sync: report our state, take the new schedule, fetch what we
 * are missing.
 */
sync_result_t sync_perform(const int64_t *now_ms);

/**
 * Parse a sync response: store the schedule and download missing assets.
 */
sync_result_t process_sync_response(const char *json, size_t len);

/**
 * Download an asset into the cache, verifying its hash.
 */
sync_result_t sync_download_asset(const char *hash);

#ifdef __cplusplus
}
#endif

#endif /* SYNC_H */

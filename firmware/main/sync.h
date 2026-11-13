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
 * The server URL that is stored, or an empty string.
 */
const char *sync_server_url(void);

/**
 * The device id that is stored, or an empty string.
 */
const char *sync_device_id(void);

/**
 * Store the server URL.
 */
esp_err_t sync_set_server_url(const char *url);

/**
 * Ensure the device has an id, generating one if it does not.
 */
esp_err_t sync_ensure_device_id(void);

/**
 * Fetch the server's time and anchor the clock to it.
 *
 * A device that has never synced has no absolute time, and the server
 * rejects a request whose timestamp is outside its accepted window. This
 * makes the first signed request possible.
 *
 * @return true if the clock was anchored.
 */
bool sync_fetch_server_time(void);

/**
 * Enrol with the server.
 *
 * The device sends its public key and receives a claim code, which the
 * owner scans to make the frame theirs.
 *
 * Enrolling is idempotent: the device may call it as often as it likes
 * while it waits to be claimed. Each call returns the code the server
 * currently holds, so the code on the panel and the code the owner needs
 * are always the same one. Once the owner claims the device, the call
 * reports that it has been claimed and the device stops enrolling.
 *
 * @param claim_code     The code that was issued.
 * @param claim_code_len The size of that buffer.
 * @param claim_url      The URL the claim QR code should point at.
 * @param claim_url_len  The size of that buffer.
 * @param claimed        Set to true when the device has been claimed.
 *
 * @return true on success.
 */
bool sync_enrol(char *claim_code, size_t claim_code_len, char *claim_url, size_t claim_url_len,
                bool *claimed);

/**
 * The claim code from the last enrolment.
 */
const char *sync_claim_code(void);

/**
 * Whether the device still has to enrol with the server.
 *
 * The device enrols until it is claimed. While it waits it keeps asking
 * the server, which keeps answering with the code it currently holds.
 */
bool sync_needs_enrol(void);

/**
 * The claim URL from the last enrolment.
 */
const char *sync_claim_url(void);

/**
 * Where the owner manages the frame.
 *
 * This is sent by the server with the schedule, and is shown on the panel
 * when the frame has been claimed but has no photos to show yet.
 */
const char *sync_dashboard_url(void);

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

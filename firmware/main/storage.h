/*
 * Storage interface.
 */

#ifndef STORAGE_H
#define STORAGE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Mount the SD card and prepare the cache directories.
 */
esp_err_t storage_init(void);

/**
 * Whether the SD card is mounted and usable.
 */
bool storage_is_mounted(void);

/**
 * The path of an asset in the cache.
 */
void storage_asset_path(const char *hash, char *out, size_t out_len);

/**
 * Whether an asset is already cached.
 */
bool storage_has_asset(const char *hash);

/**
 * The size of a cached asset, or 0 if absent.
 */
size_t storage_asset_size(const char *hash);

/**
 * Delete a cached asset.
 */
esp_err_t storage_remove_asset(const char *hash);

/**
 * Begin staging a download; returns the path to write to.
 */
esp_err_t storage_begin_staging(const char *hash, char *out_path, size_t out_len);

/**
 * Commit a staged download once its hash has been verified.
 */
esp_err_t storage_commit_staging(const char *hash, const char *staged_path, uint8_t *digest);

/**
 * Discard a staged download.
 */
void storage_abort_staging(const char *staged_path);

/**
 * Read a cached asset into a buffer.
 */
esp_err_t storage_read_asset(const char *hash, uint8_t *buffer, size_t buffer_len, size_t *out_len);

/**
 * Write the schedule file atomically.
 */
esp_err_t storage_write_schedule(const char *json, size_t len);

/**
 * Read the schedule file.
 */
esp_err_t storage_read_schedule(char *out, size_t *out_len);

#ifdef __cplusplus
}
#endif

#endif /* STORAGE_H */

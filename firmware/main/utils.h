/*
 * Small helpers shared across the firmware.
 */

#ifndef UTILS_H
#define UTILS_H

#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Format an integer into a buffer, returning the buffer.
 *
 * The HTTP client needs string headers, and several of them are numbers.
 */
const char *StringifyInt(int64_t value);

/**
 * Parse an ISO-8601 timestamp into milliseconds since the epoch.
 *
 * Only the `YYYY-MM-DDTHH:MM:SS` form is accepted, optionally with a
 * trailing `Z`. The server always sends UTC with a `Z` suffix.
 *
 * @return ESP_OK on success, ESP_ERR_INVALID_ARG if the format is not
 *         recognised.
 */
esp_err_t parse_iso8601_ms(const char *text, int64_t *out_ms);

#ifdef __cplusplus
}
#endif

#endif /* UTILS_H */

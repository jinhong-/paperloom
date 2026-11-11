/*
 * The clock.
 */

#ifndef TIME_H
#define TIME_H

#include <stdbool.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Initialise the clock.
 */
esp_err_t time_init(void);

/**
 * The current time in milliseconds since the epoch.
 */
esp_err_t time_now(int64_t *out_ms);

/**
 * Whether the clock is anchored to real time.
 */
bool time_is_valid(void);

/**
 * Correct the clock against the server's time.
 */
esp_err_t time_set_from_server(int64_t server_time_ms);

#ifdef __cplusplus
}
#endif

#endif /* TIME_H */

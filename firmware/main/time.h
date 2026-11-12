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
 * The current time in milliseconds since the epoch, or 0 on failure.
 */
int64_t time_now_ms(void);

/**
 * Whether the clock is anchored to real time.
 */
bool time_is_valid(void);

/**
 * Whether the clock's reading is plausible.
 *
 * A device that has been completely unpowered comes back with its
 * real-time clock reset to the beginning of the epoch. Such a device must
 * not be trusted: it would compute a sleep interval of decades.
 */
bool time_is_plausible(void);

/**
 * Forget that the clock was anchored.
 *
 * This is used when the clock's reading turns out to be impossible, which
 * means the offset applied to it is meaningless.
 */
void time_invalidate(void);

/**
 * Correct the clock against the server's time.
 */
esp_err_t time_set_from_server(int64_t server_time_ms);

#ifdef __cplusplus
}
#endif

#endif /* TIME_H */

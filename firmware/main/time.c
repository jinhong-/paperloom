/*
 * The clock.
 *
 * The display events are absolute UTC timestamps, so the device needs a
 * trustworthy clock. The ESP32's internal RTC keeps counting across a deep
 * sleep, but it drifts and it has no notion of absolute time until it has
 * been set.
 *
 * The strategy is:
 *
 *   - the internal RTC provides the time-of-day across deep sleeps;
 *   - the server's `server_time` in the sync response is used to correct
 *     the offset, so the clock is anchored to real time on every sync.
 *
 * Before the first sync the device has no absolute time. It still knows
 * how long it has been asleep, but it cannot place an event in absolute
 * terms, so it will not execute timed events until it has synced once.
 */

#include <stdlib.h>
#include <string.h>
#include <sys/time.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "time.h"

static const char *TAG = "time";

/* The offset between the RTC and real time, in milliseconds. */
static int64_t s_time_offset_ms = 0;

/* Whether the clock has ever been anchored to the server. */
static bool s_time_valid = false;

/**
 * Initialise the clock.
 *
 * The RTC is read from the system clock, which the bootloader keeps
 * running during deep sleep.
 */
esp_err_t time_init(void) {
    struct timeval tv;
    if (gettimeofday(&tv, NULL) != 0) {
        ESP_LOGW(TAG, "Could not read the system clock");
        return ESP_FAIL;
    }

    int64_t now = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
    ESP_LOGI(TAG, "Clock initialised at %lld", (long long)now);
    return ESP_OK;
}

/**
 * The current time in milliseconds since the epoch.
 */
esp_err_t time_now(int64_t *out_ms) {
    struct timeval tv;
    if (gettimeofday(&tv, NULL) != 0) {
        return ESP_FAIL;
    }
    *out_ms = (int64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000 + s_time_offset_ms;
    return ESP_OK;
}

/**
 * Whether the clock is anchored to real time.
 *
 * A device that has never synced has no absolute time, and must not
 * execute timed events against it.
 */
bool time_is_valid(void) {
    return s_time_valid;
}

/**
 * Correct the clock against the server's time.
 *
 * The server's time is authoritative. We store the difference as an offset
 * rather than setting the RTC directly, so that a slow clock is corrected
 * without the drift accumulating in the RTC itself.
 *
 * @param server_time_ms The server's timestamp, in milliseconds.
 */
esp_err_t time_set_from_server(int64_t server_time_ms) {
    int64_t now = 0;
    if (time_now(&now) != ESP_OK) {
        return ESP_FAIL;
    }

    /* The offset must be computed against the *unadjusted* reading, so that
     * repeated corrections do not compound. */
    int64_t raw = now - s_time_offset_ms;
    s_time_offset_ms = server_time_ms - raw;
    s_time_valid = true;

    ESP_LOGI(TAG, "Clock corrected by %lld ms", (long long)s_time_offset_ms);
    return ESP_OK;
}

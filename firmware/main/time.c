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
#include "nvs.h"

#include "time.h"

static const char *TAG = "time";

/* The offset between the RTC and real time, in milliseconds. */
static int64_t s_time_offset_ms = 0;

/* Whether the clock has ever been anchored to the server. */
static bool s_time_valid = false;

/* Where the offset is kept.
 *
 * The offset has to survive a deep sleep. A frame spends most of its life
 * asleep, and a frame that wakes up not knowing what time it is has to
 * ask the server before it can do anything, which costs a request every
 * time it wakes. */
#define NVS_NAMESPACE "paperloom"
#define NVS_KEY_TIME_OFFSET "time_offset"

/**
 * Write the offset to flash.
 */
static void time_offset_store(void) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    nvs_set_i64(nvs, NVS_KEY_TIME_OFFSET, s_time_offset_ms);
    nvs_commit(nvs);
    nvs_close(nvs);
}

/**
 * Read the offset back after a sleep.
 */
static void time_offset_restore(void) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }
    int64_t stored = 0;
    if (nvs_get_i64(nvs, NVS_KEY_TIME_OFFSET, &stored) == ESP_OK) {
        s_time_offset_ms = stored;
        s_time_valid = true;
        ESP_LOGI(TAG, "The clock was anchored before the sleep");
    }
    nvs_close(nvs);
}

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

    /* The offset from before the sleep is still good: the real-time
     * clock keeps running through a deep sleep, so the correction it
     * needed has not changed much. */
    time_offset_restore();

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
 * The current time in milliseconds since the epoch.
 */
int64_t time_now_ms(void) {
    int64_t now = 0;
    if (time_now(&now) != ESP_OK) {
        return 0;
    }
    return now;
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
    time_offset_store();

    ESP_LOGI(TAG, "Clock corrected by %lld ms", (long long)s_time_offset_ms);
    return ESP_OK;
}

/**
 * Forget that the clock was anchored.
 *
 * This is used when the clock's reading turns out to be impossible, which
 * means the offset applied to it is meaningless.
 */
void time_invalidate(void) {
    s_time_valid = false;
    s_time_offset_ms = 0;

    /* The offset is no good, so it is forgotten. */
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_erase_key(nvs, NVS_KEY_TIME_OFFSET);
        nvs_commit(nvs);
        nvs_close(nvs);
    }
}

/**
 * Whether the clock's reading is plausible.
 *
 * A device that has been completely unpowered comes back with its real-time
 * clock reset to the beginning of the epoch, so its reading is a small
 * number where a real timestamp would be enormous. Such a device must not
 * be trusted: it would compute a sleep interval of decades and appear to
 * work while showing the wrong photo at the wrong time.
 *
 * The threshold is deliberately generous: it only has to distinguish "the
 * clock has been reset" from "the clock is running", and any plausible
 * Unix timestamp in the last few decades is far above it.
 *
 * @return true if the reading looks like a real time.
 */
bool time_is_plausible(void) {
    /*
     * 2020-01-01T00:00:00Z. Anything before this means the clock has
     * been reset, not that we are living in the past.
     */
    const int64_t earliest_plausible_ms = 1577836800000LL;

    int64_t now = 0;
    if (time_now(&now) != ESP_OK) {
        return false;
    }

    return now >= earliest_plausible_ms;
}

/*
 * Paperloom firmware for the Good Display ESP32-133C02.
 *
 * The board is an ESP32-S3 with a 13.3" six-colour e-paper panel, a microSD
 * slot, and three user buttons. The firmware's whole job is:
 *
 *   wake -> optionally sync with the server -> execute any due display
 *   event -> persist state -> deep sleep
 *
 * It never decides *which* photo to show. The server precomputes a
 * timestamped schedule and the firmware executes it verbatim.
 */

#include "app_config.h"
#include "epaper.h"
#include "esp_log.h"
#include "esp_sleep.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs_flash.h"

#include "board.h"
#include "display_task.h"
#include "power.h"
#include "schedule.h"
#include "setup_mode.h"
#include "storage.h"
#include "sync.h"
#include "time.h"

static const char *TAG = "paperloom";

/**
 * Why the device woke.
 */
typedef enum {
    WAKE_POWERON,
    WAKE_TIMER,
    WAKE_BUTTON,
    WAKE_OTHER,
} wake_reason_t;

/**
 * Work out why we woke.
 *
 * A deep-sleep wake from the timer is distinguished from a button wake by
 * looking at which GPIO woke us.
 */
static wake_reason_t detect_wake_reason(void) {
    if (esp_sleep_get_wakeup_cause() == ESP_SLEEP_WAKEUP_UNDEFINED) {
        return WAKE_POWERON;
    }
    if (board_any_button_pressed()) {
        return WAKE_BUTTON;
    }
    return WAKE_TIMER;
}

/**
 * The main wake cycle.
 *
 * Returns the number of milliseconds until the device should next wake, or
 * a negative value to indicate that it should sleep indefinitely (which
 * only happens if the schedule is empty and no sync is pending).
 */
static int64_t run_cycle(wake_reason_t reason) {
    int64_t now_ms = 0;
    time_now(&now_ms);

    ESP_LOGI(TAG, "Waking: reason=%d now=%lld", (int)reason, (long long)now_ms);

    /* 1. Work out what is due. */
    bool display_due = false;
    schedule_event_t due_event;
    if (schedule_next_event(&due_event) == SCHEDULE_OK) {
        display_due = due_event.at_ms <= now_ms;
    }

    bool sync_due = false;
    if (sync_is_due(&now_ms)) {
        sync_due = true;
    }

    /* A button press always forces a sync: the user asked for it. */
    if (reason == WAKE_BUTTON) {
        sync_due = true;
        ESP_LOGI(TAG, "Button wake: forcing a sync");
    }

    /* A device whose clock has been lost, or that has been unpowered, has
     * no idea what time it is. Its schedule cannot be executed, and the
     * server would reject its requests anyway, so the only useful thing
     * it can do is get the time. */
    if (!time_is_plausible()) {
        ESP_LOGW(TAG, "The clock reads %lld ms, which is not a real time; "
                      "the device has probably lost power",
                 (long long)time_now_ms());
        sync_due = true;
        time_invalidate();
    }

    /* 2. Sync if needed. This may also bring down new assets. */
    if (sync_due) {
        ESP_LOGI(TAG, "Sync is due");

        /* The radio is only brought up when we actually need it. */
        if (board_wifi_connect() != ESP_OK) {
            ESP_LOGW(TAG, "Could not connect to Wi-Fi; continuing without a sync");
        } else {
            /* Anchor the clock before the first signed request. A device
             * that has never synced has no absolute time, and the server
             * rejects a request whose timestamp is outside its accepted
             * window. */
            if (!time_is_valid()) {
                ESP_LOGI(TAG, "The clock is not anchored yet; asking the server for the time");
                if (!sync_fetch_server_time()) {
                    ESP_LOGW(TAG, "Could not get the time from the server");
                }
            }

            /* Enrol if the server does not know us yet. The enrolment
             * sends the public key and gets back a claim code, which the
             * owner scans to make the frame theirs. */
            if (sync_claim_code()[0] == '\0') {
                char claim_code[32] = {0};
                char claim_url[160] = {0};
                if (sync_enrol(claim_code, sizeof(claim_code), claim_url, sizeof(claim_url))) {
                    ESP_LOGI(TAG, "Enrolled with the server; the claim code is %s", claim_code);

                    /* Show the claim code so the owner can scan it. */
                    display_task_show_claim_screen(claim_code, claim_url);
                } else {
                    ESP_LOGW(TAG, "Could not enrol with the server");
                }
            }

            if (sync_perform(&now_ms) == SYNC_OK) {
                /* The server may have replaced the schedule, and it may
                 * have corrected the clock, so the due check is redone
                 * against the current time rather than the one from the
                 * top of the cycle. */
                time_now(&now_ms);
                if (schedule_next_event(&due_event) == SCHEDULE_OK) {
                    display_due = due_event.at_ms <= now_ms;
                }
            } else {
                ESP_LOGW(TAG, "Sync failed; continuing with the cached schedule");
            }
        }
    }

    /* 3. Execute a due display event.
     *
     * The clock is re-read here rather than reusing the value from the
     * top of the cycle: the sync may have corrected it, and the schedule
     * is expressed in the server's time. Comparing a server timestamp
     * against a stale reading would show the wrong photo, or none. */
    if (!time_is_valid()) {
        ESP_LOGW(TAG, "The clock is still not anchored; not showing anything");
    } else if (display_due) {
        time_now(&now_ms);
        ESP_LOGI(TAG, "Display event due at %lld", (long long)due_event.at_ms);
        if (display_task_show_asset(due_event.asset_hash) == DISPLAY_OK) {
            /* Only record the asset once it is actually on the panel. */
            schedule_mark_displayed(due_event.asset_hash, due_event.at_ms);
        } else {
            ESP_LOGW(TAG, "Could not display the asset; keeping the current image");
        }
    } else if (reason == WAKE_BUTTON && board_button_pressed(BUTTON_NEXT)) {
        /* The next-photo button skips ahead in the schedule without
         * changing it. */
        ESP_LOGI(TAG, "Next-photo button pressed");
        if (display_task_show_next() == DISPLAY_OK) {
            /* The schedule is unchanged, so nothing needs recording. */
        }
    }

    /* 4. Work out when to wake next.
     *
     * The clock is read again because the sync may have corrected it.
     * Both the schedule and the next sync time are expressed in the
     * server's time, so they have to be compared against the corrected
     * clock rather than the one from the top of the cycle. */
    time_now(&now_ms);

    int64_t next_event_ms = 0;
    bool have_event = schedule_next_event(&due_event) == SCHEDULE_OK;
    if (have_event) {
        next_event_ms = due_event.at_ms;
    }

    int64_t next_sync_ms = 0;
    bool have_sync = sync_next_wake(&now_ms, &next_sync_ms);

    int64_t wake_in;
    if (have_event && have_sync) {
        wake_in = (next_event_ms < next_sync_ms) ? next_event_ms : next_sync_ms;
    } else if (have_event) {
        wake_in = next_event_ms;
    } else if (have_sync) {
        wake_in = next_sync_ms;
    } else {
        /* Nothing to do. Sleep until something wakes us. */
        ESP_LOGI(TAG, "Nothing scheduled; sleeping indefinitely");
        wake_in = -1;
    }

    int64_t delay = (wake_in < 0) ? -1 : (wake_in - now_ms);
    if (delay >= 0 && delay < 1000) {
        /* Never spin: always sleep at least a second. */
        delay = 1000;
    }

    /* A device whose clock has been lost, or that has been unpowered,
     * computes a delay against a timestamp that is far in the past. The
     * result is a sleep interval of decades, during which the frame shows
     * nothing and never checks in again. Cap the delay so that the device
     * wakes often enough to get the time from the server and recover. */
    if (delay > MAX_SLEEP_MS) {
        ESP_LOGW(TAG,
                 "The computed sleep of %lld ms is longer than the limit; "
                 "the clock is probably wrong, so waking sooner",
                 (long long)delay);
        delay = MAX_SLEEP_MS;
    }

    ESP_LOGI(TAG, "Next wake in %lld ms", (long long)delay);
    return delay;
}

void app_main(void) {
    /* The very first thing the firmware does is print. If the device is
     * boot-looping with no output at all, this line will not be seen, and
     * that itself is diagnostic: the failure is in ESP-IDF's own startup
     * rather than in this code. */
    ESP_LOGI(TAG, "Paperloom firmware %s starting", APP_VERSION);

    /* NVS is used for the device identity, Wi-Fi settings and the small
     * pieces of critical state that must survive a deep sleep. */
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);

    board_init();

    /* The e-paper holds its image without power, so the order of these
     * calls matters: bring up storage and the network, do the work, then
     * power the panel down before sleeping.
     *
     * Each step is announced before it runs, so that a failure during
     * start-up is visible on the serial console. */
    ESP_LOGI(TAG, "Step: storage");
    if (storage_init() != ESP_OK) {
        /* A missing or unreadable SD card must not stop the device. It
         * falls back to the cache in flash, and if even that is
         * unavailable the frame simply cannot show anything it has not
         * already got, so the panel keeps whatever it was showing. */
        ESP_LOGW(TAG, "Continuing without a usable cache");
    }
    ESP_LOGI(TAG, "Step: clock");
    ESP_ERROR_CHECK(time_init());
    ESP_LOGI(TAG, "Step: schedule");
    ESP_ERROR_CHECK(schedule_init());
    ESP_LOGI(TAG, "Step: sync");
    ESP_ERROR_CHECK(sync_init());
    ESP_LOGI(TAG, "Step: display");
    ESP_ERROR_CHECK(display_task_init());
    ESP_LOGI(TAG, "Step: ready");

    /* A frame with no server URL cannot do anything useful, so it waits
     * to be set up. The setup mode brings up an access point, shows the
     * screen and serves the setup page. */
    if (sync_server_url()[0] == '\0') {
        ESP_LOGW(TAG, "No server URL is configured; entering setup mode");
        setup_mode_run();
        /* setup_mode_run does not return. */
        return;
    }

    wake_reason_t reason = detect_wake_reason();
    int64_t delay = run_cycle(reason);

    /* Persist the state we want to remember across the sleep. */
    ESP_ERROR_CHECK(power_prepare_sleep(delay));

    ESP_LOGI(TAG, "Entering deep sleep");
    power_enter_deep_sleep(delay);
}

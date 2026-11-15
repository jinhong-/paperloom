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
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
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
 * The claim code that is currently on the panel.
 *
 * The device asks the server for the claim code every few seconds while
 * it waits to be claimed, and the code does not usually change. Keeping
 * track of what is on the panel means the screen is only redrawn when
 * there is something new to show, which matters because a refresh of an
 * e-paper panel takes a quarter of a minute and uses up the panel's
 * life.
 */
static char s_shown_claim_code[32] = {0};


/**
 * How long the device waits between asking the server whether it has
 * been claimed.
 *
 * The device stays awake while it waits, so this is how often it checks.
 * It is short enough that the owner sees the frame react as soon as
 * they claim it, and long enough that the server is not troubled.
 */
#define CLAIM_POLL_INTERVAL_MS 10000

/**
 * How many times a failed check-in is asked again, and how long to wait
 * between the attempts.
 *
 * A check-in that fails is not left until the next one. The frame checks
 * in every five minutes by day and every hour overnight, so a failure
 * that is not retried leaves the frame working to a plan the server has
 * moved on from, for that whole time.
 *
 * The attempts are few and close together, so that a server which is
 * down does not keep the frame awake for long.
 */
#define SYNC_RETRY_COUNT 3
#define SYNC_RETRY_DELAY_MS 5000

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
 * The chip says which source woke it, which is the only reliable way to
 * tell a button from the timer. Looking at the button lines instead does
 * not work: a quick press is over by the time the frame wakes, so the
 * lines read as if nothing had been pressed.
 */
static wake_reason_t detect_wake_reason(void) {
    esp_sleep_wakeup_cause_t cause = esp_sleep_get_wakeup_cause();

    if (cause == ESP_SLEEP_WAKEUP_UNDEFINED) {
        return WAKE_POWERON;
    }
    if (cause == ESP_SLEEP_WAKEUP_EXT1) {
        return WAKE_BUTTON;
    }
    if (cause == ESP_SLEEP_WAKEUP_TIMER) {
        return WAKE_TIMER;
    }
    return WAKE_OTHER;
}

/**
 * How long the reset button has to be held for a hard reset.
 *
 * A short press is a soft reset, which restarts the frame and makes it
 * check in with the server straight away. A long press is a hard reset,
 * which puts the frame back into setup mode.
 */
#define HARD_RESET_HOLD_MS 5000

/**
 * How much of the hold is lost while the frame wakes.
 *
 * The frame wakes as soon as the button goes down, but waking takes a
 * moment: the chip comes out of deep sleep, boots, and starts the
 * application before it starts counting. The count therefore begins a
 * little after the press did, and a press of the full length is measured
 * as being slightly shorter than it was.
 *
 * The margin is subtracted from the length that has to be measured, so
 * that a press of the full length still counts as a long one.
 */
#define HARD_RESET_WAKE_LOSS_MS 1000

/**
 * How long the reset button was held for.
 *
 * The time is measured by counting, rather than by reading the clock,
 * because the clock may not be anchored: the clock is there to tell the
 * frame what time it is, and it cannot be relied on to say how long
 * something has been held.
 *
 * @return The time in milliseconds.
 */
static int64_t reset_hold_while_pressed(void) {
    /* The length that has to be measured for the press to count as a long
     * one. It is never less than a second, so that a very long wake-up
     * cannot make every press count as a long one. */
    const int64_t needed_ms =
        HARD_RESET_HOLD_MS > HARD_RESET_WAKE_LOSS_MS
            ? HARD_RESET_HOLD_MS - HARD_RESET_WAKE_LOSS_MS
            : 1000;

    int held_ms = 0;
    while (board_button_pressed(BUTTON_RESET)) {
        if (held_ms >= needed_ms) {
            /* It has been held long enough. Stop waiting, so that the
             * frame does not sit here for as long as the button is
             * held. */
            return HARD_RESET_HOLD_MS;
        }
        vTaskDelay(pdMS_TO_TICKS(20));
        held_ms += 20;
    }
    return held_ms;
}

/**
 * Put the frame back into setup mode.
 *
 * Everything the frame knows is erased: the Wi-Fi details, the server, the
 * key it signs its requests with, and the cached photos and schedule. That
 * way the frame really is as good as new, and it comes up in setup mode
 * because it has no server to talk to.
 */
static void factory_reset(void) {
    ESP_LOGW(TAG, "The reset button was held; erasing the settings and starting again");

    /* The cache has to be mounted before it can be emptied, because the
     * photos live on the card if there is one and in the flash partition
     * if there is not. */
    if (storage_init() == ESP_OK) {
        storage_wipe();
    } else {
        ESP_LOGW(TAG, "Could not open the cache; leaving the photos where they are");
    }

    nvs_handle_t nvs;
    if (nvs_open("paperloom", NVS_READWRITE, &nvs) == ESP_OK) {
        nvs_erase_all(nvs);
        nvs_commit(nvs);
        nvs_close(nvs);
    }

    /* The Wi-Fi details may also be held by the Wi-Fi driver itself, in
     * its own namespace. */
    nvs_handle_t wifi;
    if (nvs_open("nvs.net80211", NVS_READWRITE, &wifi) == ESP_OK) {
        nvs_erase_all(wifi);
        nvs_commit(wifi);
        nvs_close(wifi);
    }

    ESP_LOGW(TAG, "The settings have been erased; restarting");
    esp_restart();
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

    ESP_LOGI(TAG, "Waking: reason=%d now=%lld cause=%d causes=0x%x", (int)reason,
             (long long)now_ms, (int)esp_sleep_get_wakeup_cause(),
             (unsigned int)esp_sleep_get_wakeup_causes());

    /* The reset button.
     *
     * A short press restarts the frame, which makes it check in with the
     * server straight away. A long press puts it back into setup mode.
     *
     * The chip does not say which button woke it, only that one of them
     * did, so the frame cannot tell a press of the reset button from a
     * press of any other. It therefore watches the reset button itself:
     * if the button is down, or it has just been let go, the press was
     * for the reset button.
     */
    if (reason == WAKE_BUTTON) {
        int64_t held_ms = reset_hold_while_pressed();
        ESP_LOGI(TAG, "The reset button was held for %lld ms", (long long)held_ms);

        if (held_ms >= HARD_RESET_HOLD_MS) {
            ESP_LOGW(TAG, "The reset button was held for a long time; wiping the frame");
            factory_reset();
        } else {
            /* The button was pressed and released. Whether it was pressed
             * just now or while the frame was asleep, it was a short
             * press.
             *
             * The restart wipes the memory, so the request for a sync is
             * put in flash first: the person who pressed the button wants
             * the frame to pick up any change to its schedule at once,
             * rather than at the next check-in. */
            ESP_LOGI(TAG, "The reset button was pressed; restarting");
            sync_request_forced();
            esp_restart();
        }
    }

    /* 1. Work out what is due.
     *
     * The event that is due is the first one whose time has arrived, not
     * the first one that is still in the future: a frame that wakes up
     * after the photo was due is exactly the case this is about.
     *
     * This is worked out before the sync, and deliberately so. The server
     * sends the events that are still to come, so a sync replaces the
     * schedule and the event that has just arrived goes with it. Looking
     * for it first is what keeps the photo from being lost. */
    bool display_due = false;
    schedule_event_t due_event;
    if (schedule_next_unseen_event(&due_event) == SCHEDULE_OK) {
        display_due = true;
    }

    bool sync_due = false;
    if (sync_is_due(&now_ms)) {
        sync_due = true;
    }

    /* The frame checks in when it cannot sleep until its next check-in
     * with a schedule that reaches that far.
     *
     * The frame's own clock cannot be trusted to say when anything is
     * due: it drifts while the frame is asleep, and the correction made
     * when it last checked in does not put it right again. A frame whose
     * clock is hours out would think its next photo was in the future
     * when it was in the past, and would sleep through it.
     *
     * So the decision is made from two numbers that both come from the
     * server: the time of the last event in the schedule, and the time
     * of the next check-in. If the schedule reaches past the check-in,
     * then whatever the clock says, the frame will wake in time for the
     * check-in, and it does not need to check in now. If it does not
     * reach that far, the frame must check in, because otherwise it
     * would run out of schedule before its next check-in came round.
     *
     * This works whatever the clock is doing.
     */
    int64_t next_sync_at = 0;
    bool have_next_sync = sync_next_sync_at(&next_sync_at);
    int64_t schedule_ends_at = schedule_last_event_ms();

    if (have_next_sync && (schedule_ends_at == 0 || schedule_ends_at < next_sync_at)) {
        sync_due = true;
    }

    /* A device that has not been claimed always checks in. It has nothing
     * to show until the owner claims it, and it is waiting to hear that
     * they have. */
    if (sync_needs_enrol()) {
        sync_due = true;
    }

    /* A button press always forces a sync: the user asked for it.
     *
     * The request is kept in flash rather than in memory, because the
     * button press restarts the frame, and a restart wipes the memory.
     * The request is only forgotten once the sync has actually happened,
     * so that it is still carried out if the frame cannot reach the
     * server at first. */
    if (sync_forced_requested()) {
        sync_due = true;
        ESP_LOGI(TAG, "A sync was asked for; forcing one");
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
    } else if (time_lost_power()) {
        /* The frame lost its power while it was asleep.
         *
         * The clock came back counting from the beginning of the epoch,
         * and the correction it had was thrown away, because it belonged
         * to a clock that no longer exists. The frame has no idea what
         * time it is, and the only thing it can do about that is ask the
         * server.
         *
         * This has to be checked on the clock's own reading, and not on
         * the time it works out to: a frame whose clock was reset and
         * then had the old correction put back on it reads a perfectly
         * plausible time, and the wrong one. */
        ESP_LOGW(TAG, "The frame lost its power while it was asleep; "
                      "the time has to be asked for again");
        sync_due = true;
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
             * window.
             *
             * The same is true of a device whose clock has drifted: the
             * server refuses the request and says why, and the clock is
             * fetched again here so that the next attempt is made with a
             * good one. */
            if (!time_is_valid()) {
                ESP_LOGI(TAG, "The clock is not anchored yet; asking the server for the time");
                if (!sync_fetch_server_time()) {
                    ESP_LOGW(TAG, "Could not get the time from the server");
                }
            }

            /* Enrol, and keep asking until the owner claims the device.
             *
             * Enrolling is idempotent: the server keeps answering with
             * the claim code it currently holds, so the code on the panel
             * and the code the owner needs are always the same one. That
             * is what makes it safe to ask again and again.
             *
             * The device waits for the owner here rather than going back
             * to sleep, because it has nothing else to show until it has
             * been claimed. It asks every few seconds. */
            if (sync_needs_enrol()) {
                char claim_code[32] = {0};
                char claim_url[512] = {0};
                bool claimed = false;

                if (sync_enrol(claim_code, sizeof(claim_code), claim_url, sizeof(claim_url),
                               &claimed)) {
                    if (claimed) {
                        ESP_LOGI(TAG, "The device has been claimed");
                    } else {
                        ESP_LOGI(TAG, "Waiting to be claimed; the claim code is %s", claim_code);

                        /* The screen is only redrawn when the code has
                         * actually changed. A refresh of an e-paper panel
                         * takes a quarter of a minute and uses up the
                         * panel's life, so there is no sense in doing it
                         * every few seconds for the same code. */
                        if (strcmp(claim_code, s_shown_claim_code) != 0) {
                            snprintf(s_shown_claim_code, sizeof(s_shown_claim_code), "%s",
                                     claim_code);
                            display_task_show_claim_screen(claim_code, claim_url);
                        }
                    }
                } else {
                    ESP_LOGW(TAG, "Could not enrol with the server");
                }
            }

            if (sync_perform(&now_ms) == SYNC_OK) {
                /* The sync has happened, so the request for one is
                 * fulfilled and can be forgotten. */
                sync_clear_forced_request();

                /* The server may have corrected the clock, so the due
                 * check is redone against the current time rather than
                 * the one from the top of the cycle.
                 *
                 * The event that was already found is kept, though. The
                 * server sends the events that are still to come, so the
                 * one that has just arrived is no longer in the schedule
                 * the sync brought back. */
                time_now(&now_ms);
                schedule_event_t later;
                if (!display_due && schedule_next_unseen_event(&later) == SCHEDULE_OK) {
                    due_event = later;
                    display_due = true;
                }
            } else {
                ESP_LOGW(TAG, "Sync failed; continuing with the cached schedule");

                /* If the server refused the request because the clock was
                 * out of the window it accepts, fetch the time and try
                 * again straight away. Waiting for the next wake would
                 * leave the frame showing nothing for as long as the
                 * schedule says. */
                if (sync_clock_was_rejected()) {
                    ESP_LOGI(TAG, "Fetching the time again, because the clock was refused");
                    if (sync_fetch_server_time()) {
                        if (sync_perform(&now_ms) == SYNC_OK) {
                            ESP_LOGI(TAG, "The retry worked");
                            sync_clear_forced_request();
                        } else {
                            ESP_LOGW(TAG, "The retry did not work either");
                        }
                    }
                } else {
                    /* The server did not refuse the request because of the
                     * clock, so the request itself failed: the server was
                     * not there, or it did not answer in time, or it
                     * answered with an error.
                     *
                     * It is worth asking again straight away. The frame
                     * is awake, it has the network, and the alternative is
                     * to sleep for another five minutes, or for an hour
                     * overnight, still working to a plan the server has
                     * moved on from.
                     *
                     * The attempts are few and close together, so that a
                     * server that is down does not keep the frame awake
                     * for long. */
                    for (int attempt = 1; attempt <= SYNC_RETRY_COUNT; attempt++) {
                        ESP_LOGW(TAG, "Sync attempt %d", attempt + 1);
                        vTaskDelay(pdMS_TO_TICKS(SYNC_RETRY_DELAY_MS));

                        if (sync_perform(&now_ms) == SYNC_OK) {
                            ESP_LOGI(TAG, "The retry worked");
                            sync_clear_forced_request();
                            break;
                        }
                    }
                }
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
    } else if (schedule_event_count() == 0) {
        /* The frame has been claimed but there is nothing to show,
         * because no photos have been chosen yet.
         *
         * Saying so is better than leaving a blank panel, which looks
         * like a fault. The screen points at the dashboard where the
         * photos are added.
         *
         * But a frame that has already shown a picture keeps it. A
         * gallery that has been turned off has nothing scheduled, and
         * the last picture is still the right thing to show: the frame
         * is meant to keep showing it until it is told otherwise. */
        const char *shown = schedule_displayed_asset();
        if (shown != NULL && shown[0] != '\0') {
            ESP_LOGI(TAG, "There is nothing to show, so the last picture stays");
        } else if (sync_needs_enrol()) {
            /* A frame that has not been claimed yet is not in this state.
             * It has nothing scheduled because it cannot sync until it is
             * claimed, and the screen it needs is the one with the claim
             * code on it. Showing the other one would tell the owner the
             * frame is ready when it is still waiting for them. */
            ESP_LOGI(TAG, "Not claimed yet; the claim screen stays");
        } else if (!display_task_ready_shown()) {
            ESP_LOGI(TAG, "There are no photos yet; showing the ready screen");
            display_task_show_ready_screen(
                sync_dashboard_url()[0] != '\0' ? sync_dashboard_url() : sync_server_url());
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

    /* The delay is how long until the frame wakes. A negative number means
     * the moment has already passed, which happens when the frame's clock
     * is behind the server's and the server's time for the next check-in
     * is in the past by the frame's reckoning.
     *
     * A negative number must never be taken as "sleep until something
     * wakes us", because that would leave the frame asleep indefinitely
     * and the picture on the panel would never change. It means wake
     * shortly, so that the frame picks up the new schedule and shows the
     * next picture. */
    int64_t delay = (wake_in < 0) ? -1 : (wake_in - now_ms);
    if (delay >= 0 && delay < 1000) {
        /* Never spin: always sleep at least a second. */
        delay = 1000;
    }
    if (delay < 0 && wake_in >= 0) {
        /* The moment has passed. Wake again shortly. */
        ESP_LOGW(TAG, "The next wake has already passed; waking again shortly");
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

    /* The power management is set up once, here, and not changed
     * afterwards. */
    power_configure();

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

    /* While the device is waiting to be claimed it stays awake and asks
     * the server every few seconds, because it has nothing else to show
     * and the owner may claim it at any moment. A deep sleep would wake
     * it far too late to be useful.
     *
     * Once it has been claimed it settles into the normal pattern: a
     * cycle, then a long sleep.
     *
     * The cycle does the asking, so it is run again after the wait. The
     * wait is skipped altogether as soon as the device has been claimed,
     * which is what ends the loop. */
    while (sync_needs_enrol()) {
        ESP_LOGI(TAG, "Waiting for the device to be claimed");
        vTaskDelay(pdMS_TO_TICKS(CLAIM_POLL_INTERVAL_MS));

        if (!sync_needs_enrol()) {
            break;
        }

        run_cycle(reason);
    }

    int64_t delay = run_cycle(reason);

    /* Persist the state we want to remember across the sleep. */
    ESP_ERROR_CHECK(power_prepare_sleep(delay));

    ESP_LOGI(TAG, "Entering deep sleep");
    power_enter_deep_sleep(delay);
}

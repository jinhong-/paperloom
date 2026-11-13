/*
 * Power management: preparing for and entering deep sleep.
 *
 * The e-paper keeps its image without power, so the device spends most of
 * its time asleep with nothing powered except the RTC. The sequence is:
 *
 *   1. Power the panel down (it holds its image on its own).
 *   2. Stop Wi-Fi.
 *   3. Persist the state we need on the next wake.
 *   4. Configure the wake source and timer.
 *   5. Sleep.
 *
 * A deep-sleep wake is much like a reboot: the wake-up path has to be fast,
 * which is why the board's setup work is minimal and the network is only
 * brought up when a sync is actually due.
 */

#include <esp_sleep.h>
#include <esp_err.h>
#include <esp_log.h>
#include <driver/gpio.h>
#include <esp_timer.h>
#include <esp_pm.h>

#include "app_config.h"
#include "board.h"
#include "display_task.h"
#include "power.h"

static const char *TAG = "power";

/**
 * Set the power management up.
 *
 * This is done once, when the device starts, and not again. Changing it
 * changes the clock tree, and the wake-up timer is set against the clock
 * as it is at that moment, so doing it at the last moment before a sleep
 * makes the frame wake at the wrong time.
 */
void power_configure(void) {
#if CONFIG_PM_ENABLE
    /* The light sleep is off: the display update is timing sensitive.
     * The frequency scaling is left on, so that the idle part of a wake
     * cycle costs less power. */
    esp_pm_config_t pm_config = {
        .max_freq_mhz = 240,
        .min_freq_mhz = 40,
        .light_sleep_enable = false,
    };
    esp_pm_configure(&pm_config);
#endif
}

/**
 * Prepare the device for sleep.
 *
 * @param delay_ms How long to sleep, or a negative value to sleep until
 *                 something wakes us.
 */
esp_err_t power_prepare_sleep(int64_t delay_ms) {
    /* The panel holds its image on its own; power it down so it can rest. */
    display_task_prepare_sleep();

    /* Wi-Fi draws a lot of power; it must be off during sleep. */
    board_wifi_stop();

    ESP_LOGI(TAG, "Prepared for sleep (%lld ms)", (long long)delay_ms);
    return ESP_OK;
}

/**
 * Enter deep sleep.
 *
 * This call does not return.
 *
 * @param delay_ms How long to sleep, or a negative value to sleep until a
 *                 button press.
 */
void power_enter_deep_sleep(int64_t delay_ms) {
    /* The buttons must be able to wake the device, so they have to be
     * configured as wake sources with the pull-up enabled.
     *
     * The buttons are active-high with an internal pull-up, so a press
     * pulls the line high and the idle state is low. The wake source
     * therefore has to be ANY_HIGH.
     *
     * With ANY_LOW the frame woke after a moment whatever it was asked to
     * sleep for, because the idle lines looked like a press.
     *
     * This is set up before the timer, because setting a wake source
     * replaces the sleep configuration. */
    gpio_config_t wake_conf = {
        .mode = GPIO_MODE_INPUT,
        .pin_bit_mask = (1ULL << BUTTON_WAKEUP) | (1ULL << BUTTON_NEXT) | (1ULL << BUTTON_RESET),
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&wake_conf);

    uint64_t button_mask = (1ULL << BUTTON_WAKEUP) | (1ULL << BUTTON_NEXT) |
                           (1ULL << BUTTON_RESET);
    esp_sleep_enable_ext1_wakeup_io(button_mask, ESP_EXT1_WAKEUP_ANY_HIGH);

    if (delay_ms > 0) {
        /* Cap the timer at the maximum the RTC can represent, so that a
         * very long delay does not overflow. */
        const uint64_t max_delay = 0xFFFFFFFFULL * 1000ULL;
        uint64_t actual = (uint64_t)delay_ms;
        if (actual > max_delay) {
            actual = max_delay;
        }

        ESP_LOGI(TAG, "Sleeping for %llu ms", (unsigned long long)actual);

        /* The error matters: a timer that is out of range is refused
         * silently, and the frame would then wake at once and spin. */
        esp_err_t err = esp_sleep_enable_timer_wakeup(actual * 1000ULL);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Could not set the wake-up timer: %s", esp_err_to_name(err));
        }
    } else {
        ESP_LOGI(TAG, "Sleeping until woken");
    }

    /* Start the deep sleep. The pins held by the e-paper driver stay in
     * their low-power state because gpio_deep_sleep_hold_en was called
     * before we got here. */
    esp_deep_sleep_start();
}

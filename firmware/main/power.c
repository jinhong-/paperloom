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
#include <driver/rtc_io.h>
#include <esp_timer.h>
#include <esp_pm.h>
#include <soc/rtc.h>

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
    /* The buttons must be able to wake the device.
     *
     * The buttons are active-high: a press pulls the line up to VCC and
     * the line rests low. The measurement on the board confirms it: with
     * nothing pressed, the three lines all read low, and pressing a
     * button drives its line high.
     *
     * So the wake level has to be high. With a low wake level the source
     * is satisfied all the time, and the frame wakes at once and never
     * sleeps properly.
     *
     * The pull-up has to be left off. The board already holds the lines
     * down, and an internal pull-up would raise them, which would make
     * the high wake level satisfied all the time and have the same
     * effect.
     *
     * The RTC's own pull-down is used rather than the digital
     * peripheral's, because the digital peripherals are powered down
     * during a deep sleep and their pull-downs go with them.
     */
    gpio_config_t wake_conf = {
        .mode = GPIO_MODE_INPUT,
        .pin_bit_mask = (1ULL << BUTTON_WAKEUP) | (1ULL << BUTTON_NEXT) | (1ULL << BUTTON_RESET),
        .pull_up_en = GPIO_PULLUP_DISABLE,
        .pull_down_en = GPIO_PULLDOWN_ENABLE,
    };
    gpio_config(&wake_conf);

    rtc_gpio_pullup_dis(BUTTON_WAKEUP);
    rtc_gpio_pulldown_en(BUTTON_WAKEUP);

    rtc_gpio_pullup_dis(BUTTON_NEXT);
    rtc_gpio_pulldown_en(BUTTON_NEXT);

    rtc_gpio_pullup_dis(BUTTON_RESET);
    rtc_gpio_pulldown_en(BUTTON_RESET);

    uint64_t button_mask = (1ULL << BUTTON_WAKEUP) | (1ULL << BUTTON_NEXT) |
                           (1ULL << BUTTON_RESET);
    esp_sleep_enable_ext1_wakeup_io(button_mask, ESP_EXT1_WAKEUP_ANY_HIGH);

    /* The lines have to rest low for the wake source to stay quiet. If
     * they read high here, something is holding them up and the frame
     * would wake at once. */
    ESP_LOGI(TAG, "The button lines rest at: wake=%d next=%d reset=%d",
             gpio_get_level(BUTTON_WAKEUP),
             gpio_get_level(BUTTON_NEXT),
             gpio_get_level(BUTTON_RESET));

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

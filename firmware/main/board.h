/*
 * Board abstraction.
 */

#ifndef BOARD_H
#define BOARD_H

#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Bring up the board's peripherals.
 */
void board_init(void);

/**
 * Whether any button is currently pressed.
 */
bool board_any_button_pressed(void);

/**
 * Whether a specific button is pressed.
 *
 * @param gpio_num The button's GPIO, e.g. BUTTON_NEXT.
 */
bool board_button_pressed(int gpio_num);

/**
 * The battery voltage in millivolts, or 0 if it cannot be measured.
 */
int board_read_battery_mv(void);

/**
 * The CA certificate used to validate the server, or NULL to use the
 * global trust store.
 */
const char *board_ca_certificate(void);

/**
 * Start Wi-Fi in station mode.
 */
esp_err_t board_wifi_start(void);

/**
 * Connect to Wi-Fi, with a bounded number of retries.
 */
esp_err_t board_wifi_connect(void);

/**
 * Whether the device has a network connection.
 */
bool board_wifi_connected(void);

/**
 * Stop Wi-Fi so it does not draw power during deep sleep.
 */
void board_wifi_stop(void);

/**
 * Store Wi-Fi credentials in NVS.
 */
esp_err_t board_set_wifi_credentials(const char *ssid, const char *password);

#ifdef __cplusplus
}
#endif

#endif /* BOARD_H */

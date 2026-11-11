/*
 * Power management.
 */

#ifndef POWER_H
#define POWER_H

#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Prepare the device for sleep: power down the panel, stop Wi-Fi.
 *
 * @param delay_ms How long we intend to sleep, or a negative value.
 */
esp_err_t power_prepare_sleep(int64_t delay_ms);

/**
 * Enter deep sleep. Does not return.
 *
 * @param delay_ms How long to sleep, or a negative value to sleep until a
 *                 button press.
 */
void power_enter_deep_sleep(int64_t delay_ms);

#ifdef __cplusplus
}
#endif

#endif /* POWER_H */

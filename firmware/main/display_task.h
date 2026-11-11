/*
 * Display task interface.
 */

#ifndef DISPLAY_TASK_H
#define DISPLAY_TASK_H

#include <stdbool.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    DISPLAY_OK,
    DISPLAY_ERROR,
    DISPLAY_EMPTY,
} display_result_t;

/**
 * Initialise the frame buffer and the panel.
 */
esp_err_t display_task_init(void);

/**
 * Show an asset, downloading it first if it is not cached.
 */
display_result_t display_task_show_asset(const char *asset_hash);

/**
 * Show the next photo in the schedule.
 */
display_result_t display_task_show_next(void);

/**
 * Power the panel down before sleeping.
 */
void display_task_prepare_sleep(void);

#ifdef __cplusplus
}
#endif

#endif /* DISPLAY_TASK_H */

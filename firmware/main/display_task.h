/*
 * Display task interface.
 */

#ifndef DISPLAY_TASK_H
#define DISPLAY_TASK_H

#include <stdbool.h>

#include "esp_err.h"

#include "setup_screen.h"

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
 * Show the setup screen.
 *
 * @param info The access point's details.
 */
display_result_t display_task_show_setup_screen(const setup_screen_info_t *info);

/**
 * Show a screen explaining that setup failed.
 */
display_result_t display_task_show_setup_error(const char *message);

/**
 * Show the claim screen.
 *
 * @param claim_code The code to enter by hand.
 * @param claim_url  The URL the QR code points at.
 */
display_result_t display_task_show_claim_screen(const char *claim_code, const char *claim_url);

/**
 * Show the screen shown once the frame has been claimed.
 *
 * The frame is working and belongs to the owner, but there is nothing to
 * show until photos have been chosen.
 *
 * @param dashboard_url The address of the dashboard.
 */
display_result_t display_task_show_ready_screen(const char *dashboard_url);

/**
 * Whether the ready screen has been shown.
 *
 * The frame shows it once, when it has been claimed but has no photos to
 * show yet. It is not shown again: the panel is refreshed on every wake
 * otherwise, which would use up its life for nothing.
 */
bool display_task_ready_shown(void);

/**
 * Forget that the ready screen has been shown.
 *
 * The frame has just been claimed, and the panel is showing the claim
 * code. The ready screen replaces it, so the flag is cleared to let it be
 * drawn.
 */
void display_task_forget_ready_screen(void);

/**
 * Whether the claim screen is on the panel.
 *
 * The frame shows it while it is waiting to be claimed, and takes it
 * down as soon as it has been claimed.
 */
bool display_task_claim_screen_shown(void);

/**
 * Power the panel down before sleeping.
 */
void display_task_prepare_sleep(void);

#ifdef __cplusplus
}
#endif

#endif /* DISPLAY_TASK_H */

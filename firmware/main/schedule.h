/*
 * The local schedule.
 */

#ifndef SCHEDULE_H
#define SCHEDULE_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * One scheduled display event.
 */
typedef struct {
    /** Epoch milliseconds at which the asset should be shown. */
    int64_t at_ms;
    /** The content hash of the asset to display. */
    char asset_hash[72];
} schedule_event_t;

typedef enum {
    SCHEDULE_OK,
    SCHEDULE_EMPTY,
} schedule_status_t;

/**
 * Load the stored schedule from the SD card.
 */
esp_err_t schedule_init(void);

/**
 * Replace the schedule with one received from the server.
 *
 * @param json The schedule document.
 * @param len  Its length in bytes.
 */
esp_err_t schedule_replace(const char *json, size_t len);

/**
 * The next event that has not yet been displayed.
 */
schedule_status_t schedule_next_event(schedule_event_t *out);

/**
 * The first event whose time has arrived.
 */
schedule_status_t schedule_due_event(schedule_event_t *out);

/**
 * Record that an asset was applied to the panel.
 */
esp_err_t schedule_mark_displayed(const char *hash, int64_t at_ms);

/**
 * The asset currently believed to be on the panel.
 */
const char *schedule_displayed_asset(void);

/**
 * The revision of the schedule the device holds.
 */
const char *schedule_revision(void);

/**
 * The number of events held.
 */
size_t schedule_event_count(void);

/**
 * The asset hash of the event at an index, or NULL if out of range.
 */
const char *schedule_asset_at(size_t index);

/**
 * Convert a UTC timestamp to milliseconds since the epoch.
 */
int64_t utc_to_epoch_ms(int year, int month, int day, int hour, int minute, int second);

#ifdef __cplusplus
}
#endif

#endif /* SCHEDULE_H */

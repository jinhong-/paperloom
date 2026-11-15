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
 * The first event whose time has arrived and whose photo is not already
 * on the panel.
 *
 * The server keeps sending an event for a little while after its time, so
 * that a frame whose clock is slightly behind does not miss it. That
 * means the same event can be offered more than once, and an event whose
 * photo is already showing is skipped.
 */
schedule_status_t schedule_next_unseen_event(schedule_event_t *out);

/**
 * Record that an asset was applied to the panel.
 */
esp_err_t schedule_mark_displayed(const char *hash, int64_t at_ms);

/**
 * The asset currently believed to be on the panel.
 */
const char *schedule_displayed_asset(void);

/**
 * When the frame last showed a picture.
 *
 * The frame will not show a picture it has already shown, and it
 * remembers the time of the last one so that it can tell. The server
 * needs to know it as well: a picture asked for has to be put at a
 * moment after this one, or the frame would skip it as one it has
 * already been shown.
 *
 * @return The time in milliseconds, or zero if nothing has been shown.
 */
int64_t schedule_last_shown_at(void);

/**
 * The revision of the schedule the device holds.
 */
const char *schedule_revision(void);

/**
 * The number of events held.
 */
size_t schedule_event_count(void);

/**
 * The time the last event in the schedule is due, or zero if the
 * schedule is empty.
 */
int64_t schedule_ends_at_ms(void);

/**
 * The time of the last event in the schedule.
 *
 * The frame needs this to decide whether it can sleep until its next
 * check-in with a schedule that reaches that far. Both times come from
 * the server, so the comparison does not depend on the frame's own clock
 * being right.
 */
int64_t schedule_last_event_ms(void);

/**
 * The asset hash of the event at an index, or NULL if out of range.
 */
const char *schedule_asset_at(size_t index);

/**
 * The hashes of the next distinct assets in schedule order.
 *
 * The current displayed asset is included first when it is present. The
 * result is what the cache should retain: the image on the panel and the
 * images that are about to replace it.
 *
 * @param hashes     The output buffer.
 * @param max_count  The capacity of the output buffer.
 * @return The number of hashes written.
 */
size_t schedule_preferred_assets(const char **hashes, size_t max_count);

/**
 * Convert a UTC timestamp to milliseconds since the epoch.
 */
int64_t utc_to_epoch_ms(int year, int month, int day, int hour, int minute, int second);

#ifdef __cplusplus
}
#endif

#endif /* SCHEDULE_H */

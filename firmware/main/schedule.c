/*
 * The local schedule.
 *
 * The server sends a window of precomputed display events; the firmware
 * stores it and executes each event at its timestamp. The device makes no
 * scheduling decisions of its own.
 *
 * The schedule lives in two places:
 *
 *   - NVS holds a small summary (the next event's time and the revision),
 *     so that the wake decision can be made without touching the SD card;
 *   - the SD card holds the full event list.
 *
 * The in-memory copy is the authority while the device is awake. NVS is
 * only used to survive a power cut between applying a schedule and
 * entering deep sleep.
 */

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_err.h"
#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include "app_config.h"
#include "schedule.h"
#include "storage.h"

static const char *TAG = "schedule";

#define NVS_NAMESPACE "paperloom"
#define NVS_KEY_NEXT_EVENT "next_event"
/* The last event that was shown, so that it is not shown again.
 *
 * A panel refresh takes a quarter of a minute and flashes the panel, and
 * a panel has a limited number of refreshes in its life. An event that
 * has been shown must therefore never be shown twice, however many times
 * the frame wakes. */
#define NVS_KEY_SHOWN_EVENT "shown_evt"
#define NVS_KEY_REVISION "sched_rev"
#define NVS_KEY_DISPLAYED "displayed"

/* The largest schedule we will hold in memory. Each event is a timestamp
 * and a 64-character hash, so this allows a few hundred events. */
#define SCHEDULE_MAX_EVENTS 128
#define SCHEDULE_MAX_JSON (64 * 1024)

static schedule_event_t s_events[SCHEDULE_MAX_EVENTS];
static size_t s_event_count = 0;
static char s_revision[72] = {0};
static char s_displayed[72] = {0};

/* The time of the last event that was shown.
 *
 * A panel refresh takes a quarter of a minute and flashes the panel, and
 * a panel has a limited number of refreshes in its life. An event that
 * has been shown must therefore never be shown again, however many times
 * the frame wakes.
 *
 * The events in a schedule are in order, so one number is enough to
 * remember them all: an event has been shown if its time is at or before
 * this one. There are often two events waiting at once, and remembering
 * only the last of them would let the frame alternate between them,
 * showing each one again and again. */
static int64_t s_last_shown_at_ms = 0;

/**
 * Rebuild the event list from a parsed JSON document.
 *
 * The document is the server's schedule object:
 *
 *   { "revision": "...", "items": [ { "at": "...", "asset": "..." } ] }
 */
static esp_err_t parse_schedule(const char *json) {
    cJSON *root = cJSON_Parse(json);
    if (root == NULL) {
        ESP_LOGE(TAG, "Failed to parse the schedule");
        return ESP_ERR_INVALID_ARG;
    }

    cJSON *revision = cJSON_GetObjectItem(root, "revision");
    cJSON *items = cJSON_GetObjectItem(root, "items");

    /* The revision is an opaque string that the server computes from the
     * schedule's contents. The device only compares it, so it does not
     * need to interpret it. */
    if (!cJSON_IsString(revision) || !cJSON_IsArray(items)) {
        ESP_LOGE(TAG, "The schedule is missing 'revision' or 'items'");
        cJSON_Delete(root);
        return ESP_ERR_INVALID_ARG;
    }

    snprintf(s_revision, sizeof(s_revision), "%s", revision->valuestring ? revision->valuestring : "");

    s_event_count = 0;
    cJSON *item = NULL;
    cJSON_ArrayForEach(item, items) {
        if (s_event_count >= SCHEDULE_MAX_EVENTS) {
            ESP_LOGW(TAG, "Schedule truncated to %d events", SCHEDULE_MAX_EVENTS);
            break;
        }

        cJSON *at = cJSON_GetObjectItem(item, "at");
        cJSON *asset = cJSON_GetObjectItem(item, "asset");
        if (!cJSON_IsString(at) || !cJSON_IsString(asset)) {
            continue;
        }

        /* The timestamp is ISO-8601 with a trailing Z. We parse it into
         * milliseconds since the epoch without pulling in a full date
         * library: the format is fixed-width. */
        int year, month, day, hour, minute, second;
        if (sscanf(at->valuestring, "%d-%d-%dT%d:%d:%d", &year, &month, &day, &hour, &minute,
                   &second) != 6) {
            ESP_LOGW(TAG, "Unparseable timestamp '%s'", at->valuestring);
            continue;
        }

        s_events[s_event_count].at_ms = utc_to_epoch_ms(year, month, day, hour, minute, second);
        snprintf(s_events[s_event_count].asset_hash, sizeof(s_events[s_event_count].asset_hash), "%s",
                 asset->valuestring);
        s_event_count++;
    }

    cJSON_Delete(root);
    ESP_LOGI(TAG, "Loaded %d events (revision %s)", (int)s_event_count, s_revision);
    return ESP_OK;
}

/**
 * Days from the civil epoch, as described in Howard Hinnant's algorithms.
 *
 * Used to convert a UTC date to a day number without a time zone database.
 */
static int64_t days_from_civil(int64_t y, unsigned m, unsigned d) {
    y -= m <= 2;
    const int64_t era = (y >= 0 ? y : y - 399) / 400;
    const unsigned yoe = (unsigned)(y - era * 400);
    const unsigned doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    const unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (int64_t)doe - 719468;
}

/**
 * Convert a UTC timestamp to milliseconds since the epoch.
 */
int64_t utc_to_epoch_ms(int year, int month, int day, int hour, int minute, int second) {
    int64_t days = days_from_civil(year, (unsigned)month, (unsigned)day);
    int64_t seconds = days * 86400 + hour * 3600 + minute * 60 + second;
    return seconds * 1000;
}

esp_err_t schedule_init(void) {
    char *buffer = malloc(SCHEDULE_MAX_JSON);
    if (buffer == NULL) {
        return ESP_ERR_NO_MEM;
    }

    size_t len = SCHEDULE_MAX_JSON;
    esp_err_t err = storage_read_schedule(buffer, &len);
    if (err != ESP_OK || len == 0) {
        ESP_LOGI(TAG, "No stored schedule");
        free(buffer);
        return ESP_OK;
    }

    err = parse_schedule(buffer);
    free(buffer);

    /* Restore the last displayed asset, which tells the server what is
     * actually on the panel. */
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) == ESP_OK) {
        size_t n = sizeof(s_displayed);
        int64_t shown = 0;
    if (nvs_get_i64(nvs, NVS_KEY_SHOWN_EVENT, &shown) == ESP_OK) {
        s_last_shown_at_ms = shown;
    }

    n = sizeof(s_displayed);
    if (nvs_get_str(nvs, NVS_KEY_DISPLAYED, s_displayed, &n) != ESP_OK) {
            s_displayed[0] = '\0';
        }
        nvs_close(nvs);
    }

    return err;
}

/**
 * Replace the schedule with a new one from the server.
 *
 * The write is atomic, so a power cut during this call leaves the previous
 * schedule intact.
 */
esp_err_t schedule_replace(const char *json, size_t len) {
    /* Validate before storing: a schedule we cannot parse would leave the
     * device with no events at all. */
    size_t event_count = 0;
    {
        char *copy = malloc(len + 1);
        if (copy == NULL) {
            return ESP_ERR_NO_MEM;
        }
        memcpy(copy, json, len);
        copy[len] = '\0';

        esp_err_t err = parse_schedule(copy);
        free(copy);
        if (err != ESP_OK) {
            return err;
        }
        event_count = s_event_count;
    }

    esp_err_t err = storage_write_schedule(json, len);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to persist the schedule");
        return err;
    }

    ESP_LOGI(TAG, "Schedule replaced with %d events", (int)event_count);
    return ESP_OK;
}

/**
 * The next event that has not yet been displayed.
 *
 * Events are stored in ascending time order, so this is a scan from the
 * front for the first event whose time is in the future.
 */
schedule_status_t schedule_next_event(schedule_event_t *out) {
    if (s_event_count == 0) {
        return SCHEDULE_EMPTY;
    }

    int64_t now = 0;
    extern esp_err_t time_now(int64_t *out_ms);
    if (time_now(&now) != ESP_OK) {
        now = 0;
    }

    for (size_t i = 0; i < s_event_count; i++) {
        if (s_events[i].at_ms > now) {
            *out = s_events[i];
            return SCHEDULE_OK;
        }
    }

    return SCHEDULE_EMPTY;
}

/**
 * The first event whose time has arrived.
 */
schedule_status_t schedule_due_event(schedule_event_t *out) {
    if (s_event_count == 0) {
        return SCHEDULE_EMPTY;
    }

    int64_t now = 0;
    extern esp_err_t time_now(int64_t *out_ms);
    if (time_now(&now) != ESP_OK) {
        now = 0;
    }

    for (size_t i = 0; i < s_event_count; i++) {
        if (s_events[i].at_ms <= now) {
            *out = s_events[i];
            return SCHEDULE_OK;
        }
    }

    return SCHEDULE_EMPTY;
}

/**
 * Whether an event has already been shown.
 *
 * The events in a schedule are in order, so an event has been shown if
 * its time is at or before the time of the last one shown.
 */
static bool event_was_shown(const schedule_event_t *event) {
    if (s_last_shown_at_ms == 0) {
        /* Nothing has been shown yet. */
        return false;
    }

    return event->at_ms <= s_last_shown_at_ms;
}

/**
 * Record that an event has been shown.
 *
 * The time is kept in flash, because the frame sleeps for long stretches
 * and comes back to a schedule that still holds the events it has
 * already shown.
 */
static void event_mark_shown(const schedule_event_t *event) {
    if (event->at_ms > s_last_shown_at_ms) {
        s_last_shown_at_ms = event->at_ms;
    }

    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    nvs_set_i64(nvs, NVS_KEY_SHOWN_EVENT, s_last_shown_at_ms);
    nvs_commit(nvs);
    nvs_close(nvs);
}

/**
 * The first event whose time has arrived and whose photo is not already
 * on the panel.
 *
 * The server keeps sending an event for a little while after its time,
 * so that a frame whose clock is slightly behind does not miss it. That
 * means the same event can be offered more than once. An event whose
 * photo is already showing is skipped, so that the frame moves on to the
 * next one rather than sitting on the same picture.
 */
schedule_status_t schedule_next_unseen_event(schedule_event_t *out) {
    if (s_event_count == 0) {
        return SCHEDULE_EMPTY;
    }

    int64_t now = 0;
    extern esp_err_t time_now(int64_t *out_ms);
    if (time_now(&now) != ESP_OK) {
        now = 0;
    }

    for (size_t i = 0; i < s_event_count; i++) {
        if (s_events[i].at_ms > now) {
            continue;
        }
        if (event_was_shown(&s_events[i])) {
            /* This one has been shown already. Showing it again would
             * cost a panel refresh for nothing. */
            continue;
        }
        if (s_displayed[0] != '\0' && strcmp(s_events[i].asset_hash, s_displayed) == 0) {
            /* This one is already on the panel. */
            continue;
        }
        *out = s_events[i];
        return SCHEDULE_OK;
    }

    return SCHEDULE_EMPTY;
}

/**
 * Record that an asset was successfully applied to the panel.
 *
 * This is the device's actual state, which the server reads at the next
 * check-in.
 */
esp_err_t schedule_mark_displayed(const char *hash, int64_t at_ms) {
    /* The event is marked as shown, so that it is not shown again. */
    for (size_t i = 0; i < s_event_count; i++) {
        if (s_events[i].at_ms == at_ms) {
            event_mark_shown(&s_events[i]);
            break;
        }
    }


    snprintf(s_displayed, sizeof(s_displayed), "%s", hash);

    nvs_handle_t nvs;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs);
    if (err != ESP_OK) {
        return err;
    }
    err = nvs_set_str(nvs, NVS_KEY_DISPLAYED, s_displayed);
    if (err == ESP_OK) {
        err = nvs_commit(nvs);
    }
    nvs_close(nvs);
    return err;
}

/**
 * The asset currently believed to be on the panel.
 */
const char *schedule_displayed_asset(void) {
    return s_displayed;
}

/**
 * The revision of the schedule the device holds.
 */
const char *schedule_revision(void) {
    return s_revision;
}

/**
 * The number of events held.
 */
size_t schedule_event_count(void) {
    return s_event_count;
}

/**
 * The time the last event in the schedule is due.
 *
 * The frame checks in when its schedule runs out, because then it has
 * nothing to show and needs a new plan. Without that, a frame whose
 * schedule had been made under different rules would keep to a plan that
 * no longer applies, and would not notice for as long as the plan said to
 * wait.
 */
int64_t schedule_ends_at_ms(void) {
    if (s_event_count == 0) {
        return 0;
    }

    int64_t last = 0;
    for (size_t i = 0; i < s_event_count; i++) {
        if (s_events[i].at_ms > last) {
            last = s_events[i].at_ms;
        }
    }
    return last;
}

/**
 * The time of the last event in the schedule, for comparing with the
 * time of the next check-in.
 *
 * The frame needs this to decide whether it can sleep until its next
 * check-in without checking in first. Both times come from the server, so
 * the comparison does not depend on the frame's own clock being right.
 */
int64_t schedule_last_event_ms(void) {
    return schedule_ends_at_ms();
}

/**
 * The asset hash of the event at an index, or NULL.
 */
const char *schedule_asset_at(size_t index) {
    if (index >= s_event_count) {
        return NULL;
    }
    return s_events[index].asset_hash;
}

/**
 * The hashes of the next distinct assets in schedule order.
 */
size_t schedule_preferred_assets(const char **hashes, size_t max_count) {
    if (hashes == NULL || max_count == 0) {
        return 0;
    }

    size_t count = 0;

    /* Keep the image that is on the panel when it is still relevant. This
     * gives the frame a stable fallback if a later download fails. */
    if (s_displayed[0] != '\0') {
        hashes[count++] = s_displayed;
    }

    /* Events are in display order. A repeated asset only occupies one
     * cache slot. */
    for (size_t i = 0; i < s_event_count && count < max_count; i++) {
        const char *hash = s_events[i].asset_hash;
        bool already_added = false;
        for (size_t j = 0; j < count; j++) {
            if (strcmp(hashes[j], hash) == 0) {
                already_added = true;
                break;
            }
        }
        if (!already_added) {
            hashes[count++] = hash;
        }
    }

    return count;
}

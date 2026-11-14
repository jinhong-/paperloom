/*
 * Displaying an asset.
 *
 * The pipeline is: download the gzip container -> verify its hash ->
 * inflate it into the frame buffer -> push it to the panel.
 *
 * The frame buffer is 960,000 bytes, which does not fit in internal RAM, so
 * it lives in PSRAM. The device must have PSRAM for this to work; the
 * ESP32-133C02 has it.
 */

#include <stdlib.h>
#include <string.h>

#include "esp_err.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "nvs.h"
#include "zlib.h"

#include "app_config.h"
#include "board.h"
#include "display_task.h"
#include "epaper.h"
#include "schedule.h"
#include "setup_screen.h"
#include "storage.h"
#include "sync.h"

static const char *TAG = "display";

/* The frame buffer. Allocated once and reused. */
static uint8_t *s_frame = NULL;

/* The panel needs a reset and init sequence before each update. */
static bool s_panel_ready = false;

/* Where the flag saying the ready screen has been shown is kept.
 *
 * It has to survive a restart, because the screen should be drawn once
 * and not on every wake: a refresh of an e-paper panel takes a quarter
 * of a minute and uses up the panel's life. */
#define NVS_NAMESPACE "paperloom"
#define NVS_KEY_READY_SHOWN "ready_shown"

/**
 * Whether the ready screen has been shown.
 */
static bool s_ready_shown = false;

/**
 * Read the flag back after a restart.
 */
static void ready_shown_restore(void) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &nvs) != ESP_OK) {
        return;
    }
    uint8_t shown = 0;
    if (nvs_get_u8(nvs, NVS_KEY_READY_SHOWN, &shown) == ESP_OK) {
        s_ready_shown = shown != 0;
    }
    nvs_close(nvs);
}

/**
 * Remember that the ready screen has been shown.
 */
static void ready_shown_store(void) {
    nvs_handle_t nvs;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &nvs) != ESP_OK) {
        return;
    }
    nvs_set_u8(nvs, NVS_KEY_READY_SHOWN, 1);
    nvs_commit(nvs);
    nvs_close(nvs);
}

esp_err_t display_task_init(void) {
    ready_shown_restore();

    if (s_frame == NULL) {
        s_frame = heap_caps_malloc(PANEL_FRAME_BYTES, MALLOC_CAP_SPIRAM);
        if (s_frame == NULL) {
            ESP_LOGE(TAG, "Failed to allocate the %d byte frame buffer", PANEL_FRAME_BYTES);
            return ESP_ERR_NO_MEM;
        }
        ESP_LOGI(TAG, "Frame buffer allocated (%d bytes in PSRAM)", PANEL_FRAME_BYTES);
    }

    if (!s_panel_ready) {
        epaper_config_t cfg = {
            .spi_host = EPD_SPI_HOST,
            .pin_cs = EPD_CS,
            .pin_cs1 = EPD_CS1,
            .pin_dc = EPD_DC,
            .pin_rst = EPD_RST,
            .pin_busy = EPD_BUSY,
            .pin_enable = EPD_ENABLE,
        };
        epaper_init(&cfg);
        s_panel_ready = true;
    }

    return ESP_OK;
}

/**
 * Inflate a gzip asset into the frame buffer.
 *
 * The inflated size must be exactly one frame; anything else means the
 * asset is corrupt or was produced for a different panel.
 */
static esp_err_t inflate_to_frame(const uint8_t *compressed, size_t compressed_len) {
    z_stream strm = {0};
    strm.avail_in = compressed_len;
    strm.next_in = (Bytef *)compressed;
    strm.avail_out = PANEL_FRAME_BYTES;
    strm.next_out = s_frame;

    /* 16 + MAX_WBITS selects gzip framing. */
    if (inflateInit2(&strm, 16 + MAX_WBITS) != Z_OK) {
        ESP_LOGE(TAG, "inflateInit2 failed");
        return ESP_FAIL;
    }

    int ret = inflate(&strm, Z_FINISH);
    size_t produced = PANEL_FRAME_BYTES - strm.avail_out;
    inflateEnd(&strm);

    if (ret != Z_STREAM_END) {
        ESP_LOGE(TAG, "Decompression failed: %d", ret);
        return ESP_FAIL;
    }

    if (produced != PANEL_FRAME_BYTES) {
        ESP_LOGE(TAG, "Asset inflated to %d bytes, expected %d", (int)produced, PANEL_FRAME_BYTES);
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * Show an asset.
 *
 * If the asset is not cached it is downloaded first. The download is staged
 * and verified before being committed to the cache, so a failure leaves the
 * previous image on the panel rather than a blank one.
 */
display_result_t display_task_show_asset(const char *asset_hash) {
    if (asset_hash == NULL || asset_hash[0] == '\0') {
        return DISPLAY_ERROR;
    }

    /* Nothing to do if this asset is already on the panel. Refreshing the
     * panel costs 30 seconds and flashes it, so it is worth avoiding. */
    const char *current = schedule_displayed_asset();
    if (current != NULL && strcmp(current, asset_hash) == 0) {
        ESP_LOGI(TAG, "Asset %s is already displayed", asset_hash);
        return DISPLAY_OK;
    }

    if (!storage_has_asset(asset_hash)) {
        ESP_LOGI(TAG, "Asset %s is not cached; downloading", asset_hash);
        if (!board_wifi_connected() && board_wifi_connect() != ESP_OK) {
            ESP_LOGW(TAG, "Could not connect to Wi-Fi to download asset %s", asset_hash);
            return DISPLAY_ERROR;
        }
        if (sync_download_asset(asset_hash) != SYNC_OK) {
            ESP_LOGW(TAG, "Could not download asset %s", asset_hash);
            return DISPLAY_ERROR;
        }
    }

    /* Read and inflate. The compressed form is at most a few hundred
     * kilobytes, so a temporary buffer is enough. */
    size_t compressed_len = storage_asset_size(asset_hash);
    if (compressed_len == 0 || compressed_len > SYNC_MAX_ASSET_BYTES) {
        ESP_LOGE(TAG, "Cached asset %s has an implausible size (%d)", asset_hash,
                 (int)compressed_len);
        return DISPLAY_ERROR;
    }

    uint8_t *compressed = malloc(compressed_len);
    if (compressed == NULL) {
        return DISPLAY_ERROR;
    }

    size_t read_len = 0;
    esp_err_t err = storage_read_asset(asset_hash, compressed, compressed_len, &read_len);
    if (err != ESP_OK || read_len != compressed_len) {
        ESP_LOGE(TAG, "Failed to read the cached asset %s", asset_hash);
        free(compressed);
        return DISPLAY_ERROR;
    }

    err = inflate_to_frame(compressed, compressed_len);
    free(compressed);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not expand asset %s", asset_hash);
        /* The cached copy is unusable; drop it so a later sync can fetch a
         * fresh one. */
        storage_remove_asset(asset_hash);
        return DISPLAY_ERROR;
    }

    ESP_LOGI(TAG, "Pushing asset %s to the panel", asset_hash);
    epaper_display(s_frame);

    return DISPLAY_OK;
}

/**
 * Show the next photo immediately, skipping ahead in the schedule.
 *
 * This backs the "next" button. It picks the event after the current one
 * without changing the schedule itself.
 */
display_result_t display_task_show_next(void) {
    size_t count = schedule_event_count();
    if (count == 0) {
        return DISPLAY_EMPTY;
    }

    const char *current = schedule_displayed_asset();

    /* Find the current position and take the next one. */
    size_t index = 0;
    for (size_t i = 0; i < count; i++) {
        const char *hash = schedule_asset_at(i);
        if (hash != NULL && current != NULL && strcmp(hash, current) == 0) {
            index = (i + 1) % count;
            break;
        }
    }

    const char *next = schedule_asset_at(index);
    if (next == NULL) {
        return DISPLAY_EMPTY;
    }

    return display_task_show_asset(next);
}

/**
 * Show the setup screen.
 *
 * The screen tells the user which network to join and what to do next.
 */
display_result_t display_task_show_setup_screen(const setup_screen_info_t *info) {
    if (s_frame == NULL) {
        return DISPLAY_ERROR;
    }

    setup_screen_draw(s_frame, info);
    epaper_display(s_frame);
    return DISPLAY_OK;
}

/**
 * Show a screen explaining that setup failed.
 */
display_result_t display_task_show_setup_error(const char *message) {
    if (s_frame == NULL) {
        return DISPLAY_ERROR;
    }

    setup_screen_draw_error(s_frame, message);
    epaper_display(s_frame);
    return DISPLAY_OK;
}

/**
 * Show the claim screen.
 *
 * This is shown once the frame has enrolled with the server and is waiting
 * for the owner to claim it.
 */
display_result_t display_task_show_claim_screen(const char *claim_code, const char *claim_url) {
    if (s_frame == NULL) {
        return DISPLAY_ERROR;
    }

    setup_screen_draw_claim(s_frame, claim_code, claim_url);
    epaper_display(s_frame);
    return DISPLAY_OK;
}

/**
 * Show the screen shown once the frame has been claimed.
 *
 * The frame is working and belongs to the owner, but there is nothing to
 * show until photos have been chosen.
 */
display_result_t display_task_show_ready_screen(const char *dashboard_url) {
    if (s_frame == NULL) {
        return DISPLAY_ERROR;
    }

    setup_screen_draw_ready(s_frame, dashboard_url);
    epaper_display(s_frame);
    s_ready_shown = true;
    ready_shown_store();
    return DISPLAY_OK;
}

/**
 * Whether the ready screen has been shown.
 *
 * The frame shows it once, when it has been claimed but has no photos to
 * show yet. It is not shown again: the panel is refreshed on every wake
 * otherwise, which would use up its life for nothing.
 */
bool display_task_ready_shown(void) {
    return s_ready_shown;
}

/**
 * Power the panel down before sleeping.
 */
void display_task_prepare_sleep(void) {
    if (s_panel_ready) {
        epaper_enter_deepsleep();
    }
}

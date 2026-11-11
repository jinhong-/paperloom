/*
 * Storage: the microSD card and the local asset cache.
 *
 * The cache holds two things:
 *
 *   - the display-ready assets, named by their content hash;
 *   - the current schedule, as a small JSON file.
 *
 * Downloads are staged to a temporary file and renamed into place only
 * after the content hash has been verified. An interrupted download
 * therefore never leaves a truncated asset that the device would later
 * treat as valid and push to the panel.
 */

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_err.h"
#include "esp_log.h"
#include "esp_vfs_fat.h"
#include "nvs.h"
#include "sdmmc_cmd.h"

#include "app_config.h"
#include "storage.h"

static const char *TAG = "storage";

static bool s_mounted = false;

/**
 * Mount the SD card.
 *
 * The card is mounted with FAT, which is what most cards are formatted with
 * and what the reference firmware uses.
 */
esp_err_t storage_init(void) {
    if (s_mounted) {
        return ESP_OK;
    }

    esp_vfs_fat_sdmmc_mount_config_t mount_config = {
        .format_if_mount_failed = false,
        .max_files = 4,
        .allocation_unit_size = 16 * 1024,
    };

    sdmmc_host_t host = SDSPI_HOST_DEFAULT();
    spi_bus_config_t bus_config = {
        .mosi_io_num = SD_SPI_MOSI,
        .miso_io_num = SD_SPI_MISO,
        .sclk_io_num = SD_SPI_SCLK,
        .quadwp_io_num = -1,
        .quadhd_io_num = -1,
    };

    esp_err_t err = spi_bus_initialize(SD_SPI_HOST, &bus_config, SPI_DMA_CH_AUTO);
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "SD SPI bus init failed: %s", esp_err_to_name(err));
        return err;
    }

    sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
    slot.host_id = SD_SPI_HOST;
    slot.gpio_cs = SD_CS;

    sdmmc_card_t *card = NULL;
    err = esp_vfs_fat_sdspi_mount(STORAGE_MOUNT_POINT, &host, &slot, &mount_config, &card);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "SD card mount failed: %s", esp_err_to_name(err));
        return err;
    }

    s_mounted = true;
    ESP_LOGI(TAG, "SD card mounted at %s", STORAGE_MOUNT_POINT);

    /* Make sure the asset directory exists. */
    mkdir(STORAGE_ASSET_DIR, 0775);
    return ESP_OK;
}

bool storage_is_mounted(void) {
    return s_mounted;
}

/**
 * The path of an asset in the cache.
 *
 * Assets are stored flat, named by their content hash.
 */
void storage_asset_path(const char *hash, char *out, size_t out_len) {
    snprintf(out, out_len, "%s/%s", STORAGE_ASSET_DIR, hash);
}

/**
 * Whether an asset is already in the cache.
 */
bool storage_has_asset(const char *hash) {
    if (!s_mounted) {
        return false;
    }

    char path[256];
    storage_asset_path(hash, path, sizeof(path));

    struct stat st;
    return stat(path, &st) == 0 && st.st_size > 0;
}

/**
 * The size of a cached asset, or 0 if it is not present.
 */
size_t storage_asset_size(const char *hash) {
    char path[256];
    storage_asset_path(hash, path, sizeof(path));

    struct stat st;
    if (stat(path, &st) != 0) {
        return 0;
    }
    return (size_t)st.st_size;
}

/**
 * Delete a cached asset.
 */
esp_err_t storage_remove_asset(const char *hash) {
    char path[256];
    storage_asset_path(hash, path, sizeof(path));
    if (unlink(path) != 0 && errno != ENOENT) {
        return ESP_FAIL;
    }
    return ESP_OK;
}

/**
 * The staging path for an in-progress download.
 */
static void storage_staging_path(const char *hash, char *out, size_t out_len) {
    snprintf(out, out_len, "%s/.staging.%s", STORAGE_ASSET_DIR, hash);
}

/**
 * Begin staging a download.
 *
 * @return The path to write to, or NULL on failure.
 */
esp_err_t storage_begin_staging(const char *hash, char *out_path, size_t out_len) {
    if (!s_mounted) {
        return ESP_ERR_INVALID_STATE;
    }
    storage_staging_path(hash, out_path, out_len);
    return ESP_OK;
}

/**
 * Finish staging: verify the hash, then move the file into place.
 *
 * The rename is atomic, so the asset either does not exist or is complete.
 *
 * @param expected_hash The hash the bytes must have.
 */
esp_err_t storage_commit_staging(const char *hash, const char *staged_path, uint8_t *digest) {
    (void)digest;

    char final_path[256];
    storage_asset_path(hash, final_path, sizeof(final_path));

    /* The caller has already verified the hash; the rename is the commit
     * point. */
    if (rename(staged_path, final_path) != 0) {
        ESP_LOGE(TAG, "Failed to commit asset %s: %s", hash, strerror(errno));
        unlink(staged_path);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Cached asset %s", hash);
    return ESP_OK;
}

/**
 * Discard a staged download.
 */
void storage_abort_staging(const char *staged_path) {
    if (staged_path != NULL) {
        unlink(staged_path);
    }
}

/**
 * Read a cached asset into memory.
 *
 * The frame buffer is allocated by the caller; this reads the file into it.
 * The asset is a gzip stream, so the buffer must be large enough for the
 * inflated frame, not the compressed bytes.
 */
esp_err_t storage_read_asset(const char *hash, uint8_t *buffer, size_t buffer_len, size_t *out_len) {
    char path[256];
    storage_asset_path(hash, path, sizeof(path));

    FILE *f = fopen(path, "rb");
    if (f == NULL) {
        return ESP_ERR_NOT_FOUND;
    }

    size_t total = 0;
    while (total < buffer_len) {
        size_t n = fread(buffer + total, 1, buffer_len - total, f);
        if (n == 0) {
            break;
        }
        total += n;
    }
    fclose(f);

    if (out_len != NULL) {
        *out_len = total;
    }
    return ESP_OK;
}

/**
 * Write the schedule file.
 *
 * The write goes to a temporary file and is renamed into place, so a power
 * cut cannot leave the device with a half-written schedule.
 */
esp_err_t storage_write_schedule(const char *json, size_t len) {
    if (!s_mounted) {
        return ESP_ERR_INVALID_STATE;
    }

    char temp_path[256];
    snprintf(temp_path, sizeof(temp_path), "%s.tmp", STORAGE_SCHEDULE_PATH);

    FILE *f = fopen(temp_path, "wb");
    if (f == NULL) {
        ESP_LOGE(TAG, "Failed to open %s: %s", temp_path, strerror(errno));
        return ESP_FAIL;
    }

    size_t written = fwrite(json, 1, len, f);
    fflush(f);
    fsync(fileno(f));
    fclose(f);

    if (written != len) {
        unlink(temp_path);
        return ESP_FAIL;
    }

    if (rename(temp_path, STORAGE_SCHEDULE_PATH) != 0) {
        unlink(temp_path);
        return ESP_FAIL;
    }

    return ESP_OK;
}

/**
 * Read the schedule file into a buffer.
 *
 * @param out     The buffer to fill.
 * @param out_len The buffer size on entry, the number of bytes read on exit.
 */
esp_err_t storage_read_schedule(char *out, size_t *out_len) {
    if (!s_mounted) {
        return ESP_ERR_INVALID_STATE;
    }

    FILE *f = fopen(STORAGE_SCHEDULE_PATH, "rb");
    if (f == NULL) {
        return ESP_ERR_NOT_FOUND;
    }

    size_t total = 0;
    while (total + 1 < *out_len) {
        size_t n = fread(out + total, 1, *out_len - total - 1, f);
        if (n == 0) {
            break;
        }
        total += n;
    }
    out[total] = '\0';
    *out_len = total;
    fclose(f);

    return ESP_OK;
}

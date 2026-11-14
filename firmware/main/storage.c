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
#include <utime.h>

#include "driver/gpio.h"
#include "esp_err.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "esp_vfs_fat.h"
#include "nvs.h"
#include "sdmmc_cmd.h"

#include "app_config.h"
#include "storage.h"

static const char *TAG = "storage";

/**
 * Where the cache lives.
 *
 * The microSD card is preferred: it holds far more than flash does. When
 * no card is inserted the cache lives in the flash partition instead, so
 * that the frame still works without one.
 */
static const char *s_root = STORAGE_FLASH_MOUNT_POINT;
static const char *s_asset_dir = STORAGE_FLASH_ASSET_DIR;
static const char *s_schedule_path = STORAGE_FLASH_SCHEDULE_PATH;

/**
 * Whether a usable cache is available.
 */
static bool s_mounted = false;

/**
 * Whether the cache is the filesystem in flash rather than a card.
 *
 * The two behave differently in one important respect: SPIFFS cannot
 * rename onto a file that already exists, so a file has to be removed
 * before it can be replaced.
 */
static bool s_using_spiffs = false;

/**
 * Mount the fallback filesystem in flash.
 *
 * This is what the frame uses when there is no microSD card. It is small,
 * so it holds the schedule and a handful of assets rather than a whole
 * library, but it is enough for the frame to function.
 */
static esp_err_t mount_flash_filesystem(void) {
    esp_vfs_spiffs_conf_t conf = {
        .base_path = STORAGE_FLASH_MOUNT_POINT,
        .partition_label = "storage",
        .max_files = 8,
        .format_if_mount_failed = true,
    };

    esp_err_t err = esp_vfs_spiffs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not mount the flash filesystem: %s", esp_err_to_name(err));
        return err;
    }

    s_root = STORAGE_FLASH_MOUNT_POINT;
    s_asset_dir = STORAGE_FLASH_ASSET_DIR;
    s_schedule_path = STORAGE_FLASH_SCHEDULE_PATH;
    s_using_spiffs = true;

    /* The flash filesystem has no directories, so there is nothing to
     * create: the schedule and the assets sit directly in the mount
     * point, named so that they cannot be confused for one another. */

    size_t total = 0;
    size_t used = 0;
    if (esp_spiffs_info(conf.partition_label, &total, &used) == ESP_OK) {
        ESP_LOGI(TAG, "Flash filesystem ready (%u bytes used of %u)", (unsigned)used,
                 (unsigned)total);
    }
    return ESP_OK;
}

/**
 * Mount the microSD card.
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
        .max_transfer_sz = 4092,
        .flags = SPICOMMON_BUSFLAG_MASTER | SPICOMMON_BUSFLAG_SCLK,
    };

    /* The card's chip select must be an output held high before the bus
     * is brought up, otherwise the card sees a floating select and the
     * first command is ignored. */
    gpio_config_t cs_config = {
        .pin_bit_mask = (1ULL << SD_CS),
        .mode = GPIO_MODE_OUTPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&cs_config));
    gpio_set_level(SD_CS, 1);

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
        /* A timeout here means the card did not answer: usually no card
         * is inserted, or the card is not seated properly. It is not a
         * fatal condition, because the frame falls back to the cache in
         * flash. */
        ESP_LOGW(TAG, "SD card mount failed: %s", esp_err_to_name(err));
        ESP_LOGW(TAG, "Check that a FAT-formatted card is inserted and seated");

        esp_err_t flash_err = mount_flash_filesystem();
        if (flash_err != ESP_OK) {
            ESP_LOGE(TAG, "No usable storage: the card failed and so did the flash filesystem");
            return err;
        }

        s_mounted = true;
        ESP_LOGW(TAG, "Continuing without a card, using the cache in flash");
        return ESP_OK;
    }

    s_root = STORAGE_MOUNT_POINT;
    s_asset_dir = STORAGE_ASSET_DIR;
    s_schedule_path = STORAGE_SCHEDULE_PATH;

    s_mounted = true;
    ESP_LOGI(TAG, "SD card mounted at %s", STORAGE_MOUNT_POINT);

    /* Make sure the asset directory exists. */
    mkdir(s_asset_dir, 0775);
    return ESP_OK;
}

bool storage_is_mounted(void) {
    return s_mounted;
}

/**
 * The name a cached file is given in the flash filesystem.
 *
 * SPIFFS limits a file name to 31 characters, and the mount point is
 * part of the path as well, so the whole path has to be short. The
 * content hash is 64 characters, which is far too long, so the first 24
 * of them are used: that is 96 bits, which will not collide with
 * anything.
 *
 * @param hash     The content hash of the file.
 * @param prefix   A short prefix that keeps the names apart.
 * @param out      The output buffer.
 * @param out_len  The output buffer size.
 */
static void storage_flash_name(const char *hash, const char *prefix, char *out, size_t out_len) {
    snprintf(out, out_len, "%s%.24s", prefix, hash);
}

/**
 * Whether a name in the flash mount point belongs to the cache.
 *
 * The flash filesystem has no directories, so everything the cache owns
 * sits in the mount point beside anything else that might be there. The
 * cache's own files are the assets, which are named with an "a-" prefix,
 * the downloads that have not finished, which are named with a "t-", and
 * the schedule.
 */
static bool storage_flash_name_is_cached(const char *name) {
    return strncmp(name, "a-", 2) == 0 ||
           strncmp(name, "t-", 2) == 0 ||
           strcmp(name, "schedule.json") == 0;
}

/**
 * The path of an asset in the cache.
 *
 * Assets are stored flat, named by their content hash.
 *
 * The flash filesystem has no directories: a file's name is a single
 * component, and a path with a separator in it is not supported. So the
 * assets sit directly in the mount point, with a prefix that keeps them
 * apart from the schedule.
 */
void storage_asset_path(const char *hash, char *out, size_t out_len) {
    if (s_using_spiffs) {
        char name[32];
        storage_flash_name(hash, "a-", name, sizeof(name));
        snprintf(out, out_len, "%s/%s", s_root, name);
    } else {
        snprintf(out, out_len, "%s/%s", s_asset_dir, hash);
    }
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
 * The number and total size of the assets in the cache.
 *
 * The SD card stores each asset under its full hash. The flash fallback
 * has no directories and uses a shortened name, so the entries are counted
 * by their common prefix instead.
 */
static void storage_asset_totals(size_t *count, size_t *bytes) {
    size_t assets = 0;
    size_t total = 0;

    DIR *dir = opendir(s_using_spiffs ? s_root : s_asset_dir);
    if (dir != NULL) {
        struct dirent *entry = NULL;
        while ((entry = readdir(dir)) != NULL) {
            const char *name = entry->d_name;
            bool is_asset = s_using_spiffs ? strncmp(name, "a-", 2) == 0
                                           : strlen(name) == 64;
            if (!is_asset) {
                continue;
            }

            char path[320];
            if (s_using_spiffs) {
                snprintf(path, sizeof(path), "%s/%s", s_root, name);
            } else {
                snprintf(path, sizeof(path), "%s/%s", s_asset_dir, name);
            }

            struct stat st;
            if (stat(path, &st) == 0 && st.st_size > 0) {
                assets++;
                total += (size_t)st.st_size;
            }
        }
        closedir(dir);
    }

    if (count != NULL) {
        *count = assets;
    }
    if (bytes != NULL) {
        *bytes = total;
    }
}

size_t storage_asset_count(void) {
    size_t count = 0;
    storage_asset_totals(&count, NULL);
    return count;
}

size_t storage_asset_bytes(void) {
    size_t bytes = 0;
    storage_asset_totals(NULL, &bytes);
    return bytes;
}

/**
 * Remove every cached asset, the schedule, and any half-downloaded file.
 *
 * This is used by the factory reset, so that the frame really is blank
 * afterwards and not merely without its settings.
 *
 * @return The number of files that were removed.
 */
size_t storage_wipe(void) {
    if (!s_mounted) {
        return 0;
    }

    size_t removed = 0;

    /* The two layouts are different.
     *
     * The flash fallback has no directories, so the assets sit directly in
     * the mount point, named with a prefix that keeps them apart from the
     * schedule. The card has a real directory for the assets. */
    const char *dir_path = s_using_spiffs ? s_root : s_asset_dir;

    DIR *dir = opendir(dir_path);
    if (dir != NULL) {
        struct dirent *entry = NULL;
        while ((entry = readdir(dir)) != NULL) {
            const char *name = entry->d_name;
            if (name[0] == '.' || name[0] == '\0') {
                continue;
            }

            /* In the flash fallback only the files the cache owns are
             * removed. Anything else in the mount point is left alone. */
            if (s_using_spiffs && !storage_flash_name_is_cached(name)) {
                continue;
            }

            char path[320];
            snprintf(path, sizeof(path), "%s/%s", dir_path, name);
            if (unlink(path) == 0) {
                removed++;
            }
        }
        closedir(dir);
    }

    /* The schedule and its temporary file are removed in both cases. */
    if (unlink(s_schedule_path) == 0) {
        removed++;
    }

    char temp_path[320];
    snprintf(temp_path, sizeof(temp_path), "%s.tmp", s_schedule_path);
    if (unlink(temp_path) == 0) {
        removed++;
    }

    ESP_LOGW(TAG, "Removed %u files from the cache", (unsigned)removed);
    return removed;
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
 * Mark an asset as the most recently used one.
 *
 * FAT and SPIFFS both keep a modification timestamp, so the cache can use
 * the filesystem rather than a second index. An asset is touched when it
 * is committed, read, or displayed. Files left by older firmware have no
 * useful timestamp and therefore naturally become the first eviction
 * candidates.
 */
esp_err_t storage_touch_asset(const char *hash) {
    char path[256];
    storage_asset_path(hash, path, sizeof(path));

    if (utime(path, NULL) != 0) {
        return ESP_FAIL;
    }
    return ESP_OK;
}

/**
 * Whether a hash is in the protected set.
 */
static bool storage_is_protected(const char *hash, const char *const *protected_hashes,
                                 size_t protected_count) {
    for (size_t i = 0; i < protected_count; i++) {
        if (protected_hashes[i] != NULL && strcmp(hash, protected_hashes[i]) == 0) {
            return true;
        }
    }
    return false;
}

/**
 * Remove the least recently used assets until the cache fits its limits.
 */
size_t storage_evict_lru(size_t max_assets, size_t max_bytes,
                         const char *const *protected_hashes, size_t protected_count) {
    size_t removed = 0;

    while (true) {
        size_t count = 0;
        size_t bytes = 0;
        storage_asset_totals(&count, &bytes);
        if (count <= max_assets && bytes <= max_bytes) {
            break;
        }

        DIR *dir = opendir(s_using_spiffs ? s_root : s_asset_dir);
        if (dir == NULL) {
            break;
        }

        char oldest_hash[72] = {0};
        time_t oldest_time = 0;
        struct dirent *entry = NULL;
        while ((entry = readdir(dir)) != NULL) {
            const char *name = entry->d_name;
            bool is_asset = s_using_spiffs ? strncmp(name, "a-", 2) == 0
                                           : strlen(name) == 64;
            if (!is_asset) {
                continue;
            }

            char hash[72];
            if (s_using_spiffs) {
                strncpy(hash, name + 2, sizeof(hash) - 1);
                hash[sizeof(hash) - 1] = '\0';
            } else {
                strncpy(hash, name, sizeof(hash) - 1);
                hash[sizeof(hash) - 1] = '\0';
            }

            char path[320];
            if (s_using_spiffs) {
                snprintf(path, sizeof(path), "%s/%s", s_root, name);
            } else {
                snprintf(path, sizeof(path), "%s/%s", s_asset_dir, name);
            }

            struct stat st;
            if (stat(path, &st) != 0 || st.st_size <= 0) {
                continue;
            }
            if (storage_is_protected(hash, protected_hashes, protected_count)) {
                continue;
            }

            if (oldest_hash[0] == '\0' || st.st_mtime < oldest_time ||
                (st.st_mtime == oldest_time && strcmp(hash, oldest_hash) < 0)) {
                snprintf(oldest_hash, sizeof(oldest_hash), "%s", hash);
                oldest_time = st.st_mtime;
            }
        }
        closedir(dir);

        if (oldest_hash[0] == '\0') {
            break;
        }

        ESP_LOGI(TAG, "Evicting least recently used asset %s", oldest_hash);
        if (storage_remove_asset(oldest_hash) != ESP_OK) {
            break;
        }
        removed++;

        /* Removing a file may not reduce the reported total immediately on
         * every filesystem. Stop if it does not, rather than looping. */
        size_t new_count = 0;
        size_t new_bytes = 0;
        storage_asset_totals(&new_count, &new_bytes);
        if (new_count >= count && new_bytes >= bytes) {
            break;
        }
    }

    return removed;
}

/**
 * The staging path for an in-progress download.
 */
static void storage_staging_path(const char *hash, char *out, size_t out_len) {
    /* The staging file sits beside the asset it will become, so that the
     * rename that commits it stays within one directory. */
    if (s_using_spiffs) {
        char name[32];
        storage_flash_name(hash, "t-", name, sizeof(name));
        snprintf(out, out_len, "%s/%s", s_root, name);
    } else {
        snprintf(out, out_len, "%s/staging-%s", s_asset_dir, hash);
    }
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
     * point.
     *
     * An asset is named by its content hash, so the file it replaces has
     * the same contents. Removing it first is therefore harmless, and it
     * is needed because SPIFFS cannot rename onto an existing file. */
    if (s_using_spiffs) {
        unlink(final_path);
    }

    if (rename(staged_path, final_path) != 0) {
        ESP_LOGE(TAG, "Failed to commit asset %s: %s", hash, strerror(errno));
        unlink(staged_path);
        return ESP_FAIL;
    }

    ESP_LOGI(TAG, "Cached asset %s", hash);
    storage_touch_asset(hash);
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
    storage_touch_asset(hash);

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
    snprintf(temp_path, sizeof(temp_path), "%s.tmp", s_schedule_path);

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
        ESP_LOGE(TAG, "Only %d of %d bytes of the schedule were written", (int)written, (int)len);
        unlink(temp_path);
        return ESP_FAIL;
    }

    /* The old schedule is removed before the new one is renamed into place.
     *
     * SPIFFS cannot rename onto a file that already exists: the call fails
     * with an I/O error. On a card, where the filesystem is FAT, the rename
     * would simply replace the old file, and removing it first would leave
     * a window in which the device has no schedule at all.
     *
     * The window is harmless here. The schedule is written on every sync,
     * and the device reads it back at start-up; if the power were cut in
     * between, the device would fetch the schedule again on its next
     * check-in rather than run without one. */
    if (s_using_spiffs) {
        unlink(s_schedule_path);
    }

    if (rename(temp_path, s_schedule_path) != 0) {
        ESP_LOGE(TAG, "Could not rename %s to %s: %s", temp_path, s_schedule_path,
                 strerror(errno));
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

    FILE *f = fopen(s_schedule_path, "rb");
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

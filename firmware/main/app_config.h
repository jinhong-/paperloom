/*
 * Build-time configuration.
 *
 * The pin assignments and panel geometry are fixed by the ESP32-133C02
 * board. They are collected here so that the rest of the firmware does not
 * need to know the board's wiring.
 */

#ifndef APP_CONFIG_H
#define APP_CONFIG_H

#include "driver/gpio.h"
#include "driver/spi_master.h"

#define APP_VERSION "0.1.0"

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

/* The 13.3" panel is 1200 x 1600 in portrait orientation. */
#define PANEL_WIDTH 1200
#define PANEL_HEIGHT 1600

/* Two pixels per byte: the even pixel is in the high nibble. */
#define PANEL_ROW_STRIDE_BYTES (PANEL_WIDTH / 2)
#define PANEL_FRAME_BYTES (PANEL_ROW_STRIDE_BYTES * PANEL_HEIGHT)

/* ------------------------------------------------------------------ */
/* SPI                                                                 */
/* ------------------------------------------------------------------ */

#define EPD_SPI_HOST SPI2_HOST
#define EPD_SPI_SCLK GPIO_NUM_9
#define EPD_SPI_MOSI GPIO_NUM_41
#define EPD_SPI_MISO GPIO_NUM_40

/* The largest chunk we push to the panel in one SPI transaction. */
#define EPD_SPI_MAX_TRANSFER_BYTES 32768

#define EPD_CS GPIO_NUM_18
#define EPD_CS1 GPIO_NUM_17
#define EPD_RST GPIO_NUM_6
#define EPD_BUSY GPIO_NUM_7
#define EPD_ENABLE GPIO_NUM_45

/* The board exposes EPD_DC on IO2, but the vendor sample drives commands
 * through the SPI command phase and leaves DC unconnected. We do the same:
 * it avoids a pin that the architecture notes flag as not yet verified. */
#define EPD_DC GPIO_NUM_NC

/* ------------------------------------------------------------------ */
/* microSD                                                             */
/* ------------------------------------------------------------------ */

#define SD_SPI_HOST SPI3_HOST
#define SD_SPI_SCLK GPIO_NUM_8
#define SD_SPI_MOSI GPIO_NUM_3
#define SD_SPI_MISO GPIO_NUM_5
#define SD_CS GPIO_NUM_15

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

/* SW2 wakes the device and forces a manual sync. */
#define BUTTON_WAKEUP GPIO_NUM_12
/* SW3 shows the next photo immediately. */
#define BUTTON_NEXT GPIO_NUM_13
/* SW4, held during boot, resets the device. */
#define BUTTON_RESET GPIO_NUM_14

#define BUTTON_ACTIVE_LEVEL 1

/* ------------------------------------------------------------------ */
/* Storage layout                                                      */
/* ------------------------------------------------------------------ */

#define STORAGE_MOUNT_POINT "/sdcard"
#define STORAGE_ASSET_DIR STORAGE_MOUNT_POINT "/assets"
#define STORAGE_SCHEDULE_PATH STORAGE_MOUNT_POINT "/schedule.json"

/* The fallback filesystem, in flash.
 *
 * The microSD card is optional. When there is no card, the schedule and
 * the assets are kept in this partition instead, so that a frame still
 * works: it holds its schedule, still shows the photos it has, and
 * still syncs.
 */
#define STORAGE_FLASH_MOUNT_POINT "/storage"
#define STORAGE_FLASH_ASSET_DIR STORAGE_FLASH_MOUNT_POINT "/assets"
#define STORAGE_FLASH_SCHEDULE_PATH STORAGE_FLASH_MOUNT_POINT "/schedule.json"

/* ------------------------------------------------------------------ */
/* Networking                                                          */
/* ------------------------------------------------------------------ */

/* The maximum age of a signed request the server will accept. */
#define SYNC_CLOCK_SKEW_MS (5 * 60 * 1000)

/* How long to wait for the server during a sync. */
#define SYNC_HTTP_TIMEOUT_MS 30000

/* The largest asset we will download, as a guard against a corrupt
 * manifest. A 1200x1600 4bpp frame is 960,000 bytes raw and compresses to
 * roughly 300 kB; 2 MB leaves generous headroom. */
#define SYNC_MAX_ASSET_BYTES (2 * 1024 * 1024)

/* The local asset cache.
 *
 * A frame cannot hold every image in a long schedule, so it keeps the
 * images closest to the next display and discards older ones as newer
 * images arrive.
 *
 * The count is the primary bound. It was three, which was too few: a
 * gallery that changes every few minutes cycles through its pictures
 * faster than three, so the frame discarded a picture and then downloaded
 * it again a few minutes later, which is radio time and therefore power
 * for nothing.
 *
 * The count is now large enough to cover a gallery that changes every
 * few minutes for an hour, which is the period a frame is awake for at
 * any one time.
 *
 * The byte limit stops a handful of unusually large images from
 * consuming the whole cache. A picture is up to two megabytes, so the
 * limit is set for a handful of the largest rather than for the average
 * one. The flash partition holds four megabytes in all, and the firmware
 * and the schedule take about one of them, so there is room for this. */
#define CACHE_MAX_ASSETS 16
#define CACHE_MAX_BYTES (4 * 1024 * 1024)

/* The largest sleep the device will take.
 *
 * A frame normally wakes every few minutes to show a photo. The limit is
 * a safety net: if the device's clock has been lost, the computed wake
 * time would be in the distant past and the delay would run to decades.
 * Capping it means the device wakes often enough to get the time from the
 * server and recover.
 */
#define MAX_SLEEP_MS (6 * 60 * 60 * 1000)

#endif /* APP_CONFIG_H */

/*
 * E-paper driver interface.
 */

#ifndef EPAPER_H
#define EPAPER_H

#include <stdbool.h>
#include <stdint.h>

/*
 * Panel colour indices.
 *
 * These are the vendor's codes, not a dense palette. Index 4 is reserved
 * and is never emitted by the server's ditherer.
 */
#define EPD_COLOR_BLACK 0x0
#define EPD_COLOR_WHITE 0x1
#define EPD_COLOR_YELLOW 0x2
#define EPD_COLOR_RED 0x3
#define EPD_COLOR_BLUE 0x5
#define EPD_COLOR_GREEN 0x6

#ifdef __cplusplus
extern "C" {
#endif

/**
 * The panel wiring.
 */
typedef struct {
    int spi_host;
    int pin_cs;
    int pin_cs1;
    int pin_dc;     /* -1 if the board does not wire DC. */
    int pin_rst;
    int pin_busy;
    int pin_enable; /* -1 if the board has no panel power enable. */
} epaper_config_t;

/**
 * Initialise the panel and its SPI bus.
 */
void epaper_init(const epaper_config_t *cfg);

/**
 * Push a frame buffer to the panel.
 *
 * @param image  PANEL_FRAME_BYTES of 4bpp data, laid out as the server
 *               produces it: two pixels per byte, the even pixel in the
 *               high nibble.
 */
void epaper_display(uint8_t *image);

/**
 * Fill the buffer with a single colour and display it.
 */
void epaper_clear(uint8_t *image, uint8_t color);

/**
 * Power the panel down and hold its pins so it can sleep.
 */
void epaper_enter_deepsleep(void);

uint16_t epaper_get_width(void);
uint16_t epaper_get_height(void);

#ifdef __cplusplus
}
#endif

#endif /* EPAPER_H */

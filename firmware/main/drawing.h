/*
 * Drawing onto the panel.
 */

#ifndef DRAWING_H
#define DRAWING_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Set one pixel.
 *
 * @param buffer The 4bpp frame buffer.
 * @param width  The buffer width in pixels.
 * @param height The buffer height in pixels.
 * @param x      The column.
 * @param y      The row.
 * @param color  The panel colour code.
 */
void draw_pixel(uint8_t *buffer, int width, int height, int x, int y, uint8_t color);

/**
 * Fill a rectangle.
 */
void draw_fill_rect(uint8_t *buffer, int width, int height, int x, int y, int w, int h,
                    uint8_t color);

/**
 * Draw a rectangle's outline.
 */
void draw_rect_outline(uint8_t *buffer, int width, int height, int x, int y, int w, int h,
                        uint8_t color);

/**
 * Draw a horizontal line.
 */
void draw_hline(uint8_t *buffer, int width, int height, int x, int y, int len, uint8_t color);

/**
 * Draw a vertical line.
 */
void draw_vline(uint8_t *buffer, int width, int height, int x, int y, int len, uint8_t color);

/**
 * Draw a single character.
 *
 * @return The advance in pixels.
 */
int draw_char(uint8_t *buffer, int width, int height, int x, int y, char c, uint8_t color);

/**
 * Draw a string. A newline moves to the next line.
 *
 * @return The width in pixels that was drawn.
 */
int draw_text(uint8_t *buffer, int width, int height, int x, int y, const char *text,
               uint8_t color);

/**
 * Draw a string scaled up by an integer factor.
 */
int draw_text_scaled(uint8_t *buffer, int width, int height, int x, int y, const char *text,
                      uint8_t color, int scale);

/**
 * Draw a string centred horizontally.
 */
void draw_text_centered(uint8_t *buffer, int width, int height, int y, const char *text,
                        uint8_t color, int scale);

/**
 * Draw a string centred horizontally and vertically within a band.
 */
void draw_text_centered_in_band(uint8_t *buffer, int width, int height, int band_top,
                                int band_height, const char *text, uint8_t color, int scale);

/**
 * The width a string would occupy, without drawing it.
 */
int measure_text(const char *text, int scale);

/**
 * The height a string would occupy, without drawing it.
 */
int measure_text_height(const char *text, int scale);

#ifdef __cplusplus
}
#endif

#endif /* DRAWING_H */

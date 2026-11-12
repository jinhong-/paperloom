/*
 * Drawing a QR code onto the panel.
 */

#ifndef QR_H
#define QR_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Draw a QR code.
 *
 * A white quiet zone is drawn around the code, because a reader needs one
 * to find the code's edges.
 *
 * @param buffer The frame buffer.
 * @param width  The buffer width.
 * @param height The buffer height.
 * @param x      The left edge of the code.
 * @param y      The top edge of the code.
 * @param size   The size of the code in pixels, excluding the margin.
 * @param text   The text to encode.
 *
 * @return true on success.
 */
bool qr_draw(uint8_t *buffer, int width, int height, int x, int y, int size, const char *text);

#ifdef __cplusplus
}
#endif

#endif /* QR_H */

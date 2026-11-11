/*
 * E-paper driver for the Good Display ESP32-133C02.
 *
 * The panel is a 13.3" six-colour e-paper driven over SPI. It has two chip
 * selects: the image is split into a left half and a right half, each of
 * which is written through its own CS line.
 *
 * The frame buffer layout is 4 bits per pixel: two pixels per byte, the
 * even (left) pixel in the high nibble and the odd (right) pixel in the low
 * nibble. Rows are contiguous with no padding, so the row stride is
 * exactly PANEL_WIDTH / 2 bytes. This must match the server's panel.ts
 * exactly.
 *
 * Colour indices are the vendor's codes:
 *
 *   0 black, 1 white, 2 yellow, 3 red, 4 reserved, 5 blue, 6 green
 */

#include "driver/gpio.h"
#include "driver/spi_master.h"
#include "epaper.h"
#include "esp_err.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "app_config.h"

static const char *TAG = "epaper";

static epaper_config_t g_cfg;
static spi_device_handle_t s_spi;

/* Panel command codes. */
#define PSR 0x00
#define PWR 0x01
#define POF 0x02
#define PON 0x04
#define BTST_N 0x05
#define BTST_P 0x06
#define DTM 0x10
#define DRF 0x12
#define CDI 0x50
#define TCON 0x60
#define TRES 0x61
#define AN_TM 0x74
#define AGID 0x86
#define BUCK_BOOST_VDDN 0xB0
#define TFT_VCOM_POWER 0xB1
#define EN_BUF 0xB6
#define BOOST_VDDP_EN 0xB7
#define CCSET 0xE0
#define PWS 0xE3
#define CMD66 0xF0

static const uint8_t PSR_V[] = {0xDF, 0x69};
static const uint8_t PWR_V[] = {0x0F, 0x00, 0x28, 0x2C, 0x28, 0x38};
static const uint8_t POF_V[] = {0x00};
static const uint8_t DRF_V[] = {0x01};
static const uint8_t CDI_V[] = {0xF7};
static const uint8_t TCON_V[] = {0x03, 0x03};
static const uint8_t TRES_V[] = {0x04, 0xB0, 0x03, 0x20};
static const uint8_t CMD66_V[] = {0x49, 0x55, 0x13, 0x5D, 0x05, 0x10};
static const uint8_t EN_BUF_V[] = {0x07};
static const uint8_t CCSET_V[] = {0x01};
static const uint8_t PWS_V[] = {0x22};
static const uint8_t AN_TM_V[] = {0xC0, 0x1E, 0x1E, 0xCE, 0xCE, 0xCE, 0x15, 0x15, 0x55};
static const uint8_t AGID_V[] = {0x10};
static const uint8_t BTST_P_V[] = {0xE8, 0x28};
static const uint8_t BOOST_VDDP_EN_V[] = {0x01};
static const uint8_t BTST_N_V[] = {0xE8, 0x28};
static const uint8_t BUCK_BOOST_VDDN_V[] = {0x01};
static const uint8_t TFT_VCOM_POWER_V[] = {0x02};

/* Half a row in bytes; this is what each chip select writes per row. */
#define HALF_ROW_BYTES (PANEL_ROW_STRIDE_BYTES / 2)

static void cs_all(int level) {
    gpio_set_level(g_cfg.pin_cs, level);
    gpio_set_level(g_cfg.pin_cs1, level);
}

static void cs_select(int cs_index, int level) {
    gpio_set_level(cs_index == 0 ? g_cfg.pin_cs : g_cfg.pin_cs1, level);
}

static void spi_write_data(const uint8_t *data, size_t len) {
    if (g_cfg.pin_dc >= 0) {
        gpio_set_level(g_cfg.pin_dc, 1);
    }

    while (len > 0) {
        size_t chunk = len > EPD_SPI_MAX_TRANSFER_BYTES ? EPD_SPI_MAX_TRANSFER_BYTES : len;
        spi_transaction_t t = {
            .length = chunk * 8,
            .tx_buffer = data,
        };
        ESP_ERROR_CHECK(spi_device_transmit(s_spi, &t));
        data += chunk;
        len -= chunk;
    }
}

static void write_command(uint8_t cmd) {
    if (g_cfg.pin_dc >= 0) {
        gpio_set_level(g_cfg.pin_dc, 0);
        spi_transaction_t t = {
            .length = 8,
            .tx_buffer = &cmd,
        };
        ESP_ERROR_CHECK(spi_device_transmit(s_spi, &t));
    } else {
        spi_transaction_ext_t t = {
            .command_bits = 8,
            .base = {
                .cmd = cmd,
                .flags = SPI_TRANS_VARIABLE_CMD,
            },
        };
        ESP_ERROR_CHECK(spi_device_transmit(s_spi, &t.base));
    }
}

static void write_cmd_data(uint8_t cmd, const uint8_t *data, size_t len) {
    if (g_cfg.pin_dc >= 0) {
        gpio_set_level(g_cfg.pin_dc, 0);
        spi_transaction_t t = {
            .length = 8,
            .tx_buffer = &cmd,
        };
        ESP_ERROR_CHECK(spi_device_transmit(s_spi, &t));

        if (len > 0) {
            spi_write_data(data, len);
        }
    } else {
        spi_transaction_ext_t t = {
            .command_bits = 8,
            .base = {
                .cmd = cmd,
                .length = len * 8,
                .tx_buffer = data,
                .flags = SPI_TRANS_VARIABLE_CMD,
            },
        };
        ESP_ERROR_CHECK(spi_device_transmit(s_spi, &t.base));
    }
}

static bool is_busy(void) {
    return gpio_get_level(g_cfg.pin_busy) == 0;
}

static void wait_busy(const char *label) {
    vTaskDelay(pdMS_TO_TICKS(10));
    int wait_count = 0;
    while (is_busy()) {
        vTaskDelay(pdMS_TO_TICKS(10));
        if (++wait_count > 4000) {
            ESP_LOGW(TAG, "[%s] BUSY timeout after 40s", label);
            return;
        }
    }
}

static void gpio_init(void) {
    gpio_hold_dis(g_cfg.pin_cs);
    gpio_hold_dis(g_cfg.pin_cs1);
    gpio_hold_dis(g_cfg.pin_rst);
    if (g_cfg.pin_dc >= 0) {
        gpio_hold_dis(g_cfg.pin_dc);
    }

    gpio_set_level(g_cfg.pin_cs, 1);
    gpio_set_level(g_cfg.pin_cs1, 1);
    gpio_set_level(g_cfg.pin_rst, 1);
    if (g_cfg.pin_dc >= 0) {
        gpio_set_level(g_cfg.pin_dc, 0);
    }

    uint64_t output_mask = (1ULL << g_cfg.pin_rst) | (1ULL << g_cfg.pin_cs) |
                           (1ULL << g_cfg.pin_cs1);
    if (g_cfg.pin_dc >= 0) {
        output_mask |= (1ULL << g_cfg.pin_dc);
    }
    gpio_config_t out_conf = {
        .mode = GPIO_MODE_OUTPUT,
        .pin_bit_mask = output_mask,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&out_conf));

    gpio_config_t in_conf = {
        .mode = GPIO_MODE_INPUT,
        .pin_bit_mask = (1ULL << g_cfg.pin_busy),
    };
    ESP_ERROR_CHECK(gpio_config(&in_conf));

    if (g_cfg.pin_enable >= 0) {
        gpio_hold_dis(g_cfg.pin_enable);
        gpio_config_t en_conf = {
            .mode = GPIO_MODE_OUTPUT,
            .pin_bit_mask = (1ULL << g_cfg.pin_enable),
        };
        ESP_ERROR_CHECK(gpio_config(&en_conf));
        gpio_set_level(g_cfg.pin_enable, 1);
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}

static void spi_add_device(void) {
    spi_device_interface_config_t devcfg = {
        .command_bits = 0,
        .clock_speed_hz = 10 * 1000 * 1000,
        .mode = 0,
        .spics_io_num = -1,
        .queue_size = 7,
    };
    ESP_ERROR_CHECK(spi_bus_add_device(g_cfg.spi_host, &devcfg, &s_spi));
}

static void hw_reset(void) {
    gpio_set_level(g_cfg.pin_rst, 0);
    vTaskDelay(pdMS_TO_TICKS(20));
    gpio_set_level(g_cfg.pin_rst, 1);
    vTaskDelay(pdMS_TO_TICKS(20));
}

static void cmd_one(int cs_index, uint8_t cmd, const uint8_t *data, size_t len) {
    cs_select(cs_index, 0);
    write_cmd_data(cmd, data, len);
    cs_select(cs_index, 1);
}

static void cmd_all(uint8_t cmd, const uint8_t *data, size_t len) {
    cs_all(0);
    write_cmd_data(cmd, data, len);
    cs_all(1);
}

static void command_all(uint8_t cmd) {
    cs_all(0);
    write_command(cmd);
    cs_all(1);
}

static void send_init_sequence(void) {
    hw_reset();
    wait_busy("reset");

    cmd_one(0, AN_TM, AN_TM_V, sizeof(AN_TM_V));
    cmd_all(CMD66, CMD66_V, sizeof(CMD66_V));
    cmd_all(PSR, PSR_V, sizeof(PSR_V));
    cmd_all(CDI, CDI_V, sizeof(CDI_V));
    cmd_all(TCON, TCON_V, sizeof(TCON_V));
    cmd_all(AGID, AGID_V, sizeof(AGID_V));
    cmd_all(PWS, PWS_V, sizeof(PWS_V));
    cmd_all(CCSET, CCSET_V, sizeof(CCSET_V));
    cmd_all(TRES, TRES_V, sizeof(TRES_V));
    cmd_one(0, PWR, PWR_V, sizeof(PWR_V));
    cmd_one(0, EN_BUF, EN_BUF_V, sizeof(EN_BUF_V));
    cmd_one(0, BTST_P, BTST_P_V, sizeof(BTST_P_V));
    cmd_one(0, BOOST_VDDP_EN, BOOST_VDDP_EN_V, sizeof(BOOST_VDDP_EN_V));
    cmd_one(0, BTST_N, BTST_N_V, sizeof(BTST_N_V));
    cmd_one(0, BUCK_BOOST_VDDN, BUCK_BOOST_VDDN_V, sizeof(BUCK_BOOST_VDDN_V));
    cmd_one(0, TFT_VCOM_POWER, TFT_VCOM_POWER_V, sizeof(TFT_VCOM_POWER_V));
}

/**
 * Write one half of the image through one chip select.
 *
 * @param image     The full frame buffer.
 * @param cs_index  0 for the left half, 1 for the right half.
 * @param offset    Byte offset of this half within each row.
 */
static void send_image_half(const uint8_t *image, int cs_index, size_t offset) {
    uint8_t line_buf[HALF_ROW_BYTES];

    cs_select(cs_index, 0);
    write_command(DTM);
    for (uint16_t row = 0; row < PANEL_HEIGHT; row++) {
        memcpy(line_buf, image + (size_t)row * PANEL_ROW_STRIDE_BYTES + offset, HALF_ROW_BYTES);
        spi_write_data(line_buf, HALF_ROW_BYTES);
    }
    cs_select(cs_index, 1);
}

static void display_refresh(void) {
    ESP_LOGI(TAG, "Powering display on");
    command_all(PON);
    wait_busy("power_on");

    vTaskDelay(pdMS_TO_TICKS(30));
    cmd_all(DRF, DRF_V, sizeof(DRF_V));
    wait_busy("refresh");

    ESP_LOGI(TAG, "Powering display off");
    cmd_all(POF, POF_V, sizeof(POF_V));
    wait_busy("power_off");
}

uint16_t epaper_get_width(void) {
    return PANEL_WIDTH;
}

uint16_t epaper_get_height(void) {
    return PANEL_HEIGHT;
}

void epaper_init(const epaper_config_t *cfg) {
    g_cfg = *cfg;

    ESP_LOGI(TAG, "Initialising GDEP133C02 13.3\" e-paper driver (%dx%d)", PANEL_WIDTH,
             PANEL_HEIGHT);

    spi_add_device();
    gpio_init();
}

void epaper_clear(uint8_t *image, uint8_t color) {
    uint8_t packed = (color << 4) | color;
    memset(image, packed, PANEL_FRAME_BYTES);
    epaper_display(image);
}

void epaper_display(uint8_t *image) {
    ESP_LOGI(TAG, "Display update: %d bytes", PANEL_FRAME_BYTES);

    send_init_sequence();
    send_image_half(image, 0, 0);
    send_image_half(image, 1, HALF_ROW_BYTES);
    display_refresh();

    ESP_LOGI(TAG, "Display update complete");
}

void epaper_enter_deepsleep(void) {
    ESP_LOGI(TAG, "Entering panel sleep");

    cmd_all(POF, POF_V, sizeof(POF_V));
    wait_busy("deepsleep_power_off");

    if (g_cfg.pin_enable >= 0) {
        gpio_set_level(g_cfg.pin_cs, 0);
        gpio_set_level(g_cfg.pin_cs1, 0);
        if (g_cfg.pin_dc >= 0) {
            gpio_set_level(g_cfg.pin_dc, 0);
        }
        gpio_set_level(g_cfg.pin_rst, 0);

        vTaskDelay(pdMS_TO_TICKS(100));
        gpio_set_level(g_cfg.pin_enable, 0);

        /* Hold the pins so they do not float during deep sleep, which
         * would back-power the panel and prevent it from sleeping. */
        gpio_hold_en(g_cfg.pin_enable);
        gpio_hold_en(g_cfg.pin_cs);
        gpio_hold_en(g_cfg.pin_cs1);
        if (g_cfg.pin_dc >= 0) {
            gpio_hold_en(g_cfg.pin_dc);
        }
        gpio_hold_en(g_cfg.pin_rst);
        gpio_deep_sleep_hold_en();
    }
}

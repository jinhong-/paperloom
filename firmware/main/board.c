/*
 * Board abstraction for the ESP32-133C02.
 *
 * Everything that knows about this specific board lives here: the buttons,
 * the battery measurement, the Wi-Fi connection and the clock. The rest of
 * the firmware talks to this interface instead.
 */

#include <string.h>

#include "driver/gpio.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "time.h"

#include "lwip/sockets.h"

#include "app_config.h"
#include "board.h"

static const char *TAG = "board";

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAIL_BIT BIT1

static EventGroupHandle_t s_wifi_events;
static bool s_wifi_started = false;
static int s_retry_count = 0;

/* The maximum number of Wi-Fi retries before we give up and try again on
 * the next wake. */
#define WIFI_MAX_RETRIES 5

/**
 * Bring up the board's peripherals.
 */
void board_init(void) {
    gpio_config_t button_conf = {
        .mode = GPIO_MODE_INPUT,
        .pin_bit_mask = (1ULL << BUTTON_WAKEUP) | (1ULL << BUTTON_NEXT) | (1ULL << BUTTON_RESET),
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    gpio_config(&button_conf);

    /* Make sure the panel is powered down while we are not using it. */
    gpio_config_t enable_conf = {
        .mode = GPIO_MODE_OUTPUT,
        .pin_bit_mask = (1ULL << EPD_ENABLE),
    };
    gpio_config(&enable_conf);
    gpio_set_level(EPD_ENABLE, 0);

    s_wifi_events = xEventGroupCreate();
}

/**
 * Whether any button is currently pressed.
 */
bool board_any_button_pressed(void) {
    return gpio_get_level(BUTTON_WAKEUP) == BUTTON_ACTIVE_LEVEL ||
           gpio_get_level(BUTTON_NEXT) == BUTTON_ACTIVE_LEVEL ||
           gpio_get_level(BUTTON_RESET) == BUTTON_ACTIVE_LEVEL;
}

/**
 * Whether a specific button is pressed.
 */
bool board_button_pressed(int gpio_num) {
    return gpio_get_level(gpio_num) == BUTTON_ACTIVE_LEVEL;
}

/**
 * The battery voltage in millivolts, or 0 if it cannot be measured.
 *
 * The architecture notes are explicit that the battery-sense pin has not
 * been verified on this board, so this returns 0 until the wiring is
 * confirmed. Reporting a made-up voltage would be worse than reporting
 * none.
 */
int board_read_battery_mv(void) {
    return 0;
}

/**
 * Whether the frame is running on battery rather than mains power.
 *
 * The battery-sense pin has not been verified on this board, so there is
 * nothing to measure yet. The frame behaves the same either way; the
 * answer only tells the server how much it may ask the frame to download.
 */
bool board_is_on_battery(void) {
    return false;
}

/**
 * The CA certificate used to validate the server, or NULL to use the
 * global trust store.
 */
const char *board_ca_certificate(void) {
    return NULL;
}

/**
 * The Wi-Fi event handler.
 */
static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id,
                               void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
        ESP_LOGW(TAG, "Disconnected from Wi-Fi");
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        ESP_LOGI(TAG, "Connected, address " IPSTR, IP2STR(&event->ip_info.ip));
        xEventGroupSetBits(s_wifi_events, WIFI_CONNECTED_BIT);
    }
}

/**
 * Start Wi-Fi in station mode.
 */
esp_err_t board_wifi_start(void) {
    if (s_wifi_started) {
        return ESP_OK;
    }

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t config = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&config));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID,
                                                        wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP,
                                                        wifi_event_handler, NULL, NULL));

    s_wifi_started = true;
    return ESP_OK;
}

/**
 * Connect to Wi-Fi, retrying a bounded number of times.
 *
 * The device is in deep sleep most of the time, so it is better to fail
 * quickly and try again on the next wake than to sit here retrying.
 */
esp_err_t board_wifi_connect(void) {
    if (!s_wifi_started) {
        ESP_ERROR_CHECK(board_wifi_start());
    }

    nvs_handle_t nvs;
    char ssid[33] = {0};
    char password[65] = {0};
    size_t len = sizeof(ssid);

    if (nvs_open("paperloom", NVS_READONLY, &nvs) == ESP_OK) {
        if (nvs_get_str(nvs, "wifi_ssid", ssid, &len) != ESP_OK) {
            ssid[0] = '\0';
        }
        len = sizeof(password);
        if (nvs_get_str(nvs, "wifi_pass", password, &len) != ESP_OK) {
            password[0] = '\0';
        }
        nvs_close(nvs);
    }

    if (ssid[0] == '\0') {
        ESP_LOGW(TAG, "No Wi-Fi credentials stored");
        return ESP_ERR_INVALID_STATE;
    }

    /* The station config holds the SSID and password in fixed-size
     * arrays, so they are copied rather than pointed at. */
    wifi_config_t config;
    memset(&config, 0, sizeof(config));
    snprintf((char *)config.sta.ssid, sizeof(config.sta.ssid), "%s", ssid);
    snprintf((char *)config.sta.password, sizeof(config.sta.password), "%s", password);
    config.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &config));
    ESP_ERROR_CHECK(esp_wifi_start());

    ESP_LOGI(TAG, "Connecting to %s", ssid);

    EventBits_t bits = xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(15000));
    if (bits & WIFI_CONNECTED_BIT) {
        s_retry_count = 0;
        return ESP_OK;
    }

    /* Retry a few times before giving up for this wake cycle. */
    for (int attempt = 0; attempt < WIFI_MAX_RETRIES; attempt++) {
        ESP_LOGW(TAG, "Wi-Fi connect attempt %d", attempt + 1);
        esp_wifi_connect();

        bits = xEventGroupWaitBits(s_wifi_events, WIFI_CONNECTED_BIT, pdFALSE, pdFALSE,
                                   pdMS_TO_TICKS(8000));
        if (bits & WIFI_CONNECTED_BIT) {
            s_retry_count = 0;
            return ESP_OK;
        }
    }

    s_retry_count++;
    return ESP_FAIL;
}

/**
 * Whether the device has a network connection.
 */
bool board_wifi_connected(void) {
    if (!s_wifi_started || s_wifi_events == NULL) {
        return false;
    }
    return (xEventGroupGetBits(s_wifi_events) & WIFI_CONNECTED_BIT) != 0;
}

/**
 * Stop Wi-Fi so that it does not draw power during deep sleep.
 */
void board_wifi_stop(void) {
    if (!s_wifi_started) {
        return;
    }
    esp_wifi_stop();
    xEventGroupClearBits(s_wifi_events, WIFI_CONNECTED_BIT);
}

/**
 * The AP's channel.
 */
#define AP_CHANNEL 1

/**
 * The AP's maximum number of clients.
 */
#define AP_MAX_CLIENTS 4

/**
 * Start a Wi-Fi access point.
 *
 * The access point is how the frame is set up: the user joins it and opens
 * the setup page. The name and passphrase are shown on the panel.
 *
 * @param ssid     The network name.
 * @param password The passphrase. At least eight characters.
 *
 * @return ESP_OK on success.
 */
esp_err_t board_wifi_start_ap(const char *ssid, const char *password) {
    if (!s_wifi_started) {
        ESP_ERROR_CHECK(board_wifi_start());
    }

    esp_netif_t *ap_netif = esp_netif_create_default_wifi_ap();
    if (ap_netif == NULL) {
        ESP_LOGE(TAG, "Could not create the access point's network interface");
        return ESP_FAIL;
    }

    wifi_config_t config;
    memset(&config, 0, sizeof(config));
    snprintf((char *)config.ap.ssid, sizeof(config.ap.ssid), "%s", ssid);
    snprintf((char *)config.ap.password, sizeof(config.ap.password), "%s", password);
    config.ap.ssid_len = (uint8_t)strlen(ssid);
    config.ap.channel = AP_CHANNEL;
    config.ap.max_connection = AP_MAX_CLIENTS;
    config.ap.authmode = WIFI_AUTH_WPA2_PSK;
    /* The passphrase is always set, so the network is always protected.
     * The screen shows it, which is the point: the frame is on a table in
     * the owner's home, and anyone nearby could read the panel.
     *
     * Protected management frames are left at their default, which means
     * the frame will use them if the phone offers them but does not insist
     * on them. Insisting would stop some phones from joining. */

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_AP));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &config));
    ESP_ERROR_CHECK(esp_wifi_start());

    /* Start the DHCP server.
     *
     * Without it a client can join the network but is given no address,
     * so it cannot reach the setup page at all. The user would see the
     * frame's screen say "join this network" and then find that nothing
     * works.
     *
     * The default access point's network interface already starts a DHCP
     * server, so this is usually a no-op that reports that it is already
     * running. That is not a failure. */
    esp_err_t err = esp_netif_dhcps_start(ap_netif);
    if (err != ESP_OK && err != ESP_ERR_ESP_NETIF_DHCP_ALREADY_STARTED) {
        ESP_LOGE(TAG, "Could not start the DHCP server: %s", esp_err_to_name(err));
        return err;
    }

    ESP_LOGI(TAG, "Access point \"%s\" started, serving %s", ssid, board_ap_address());
    return ESP_OK;
}

/**
 * Stop the access point.
 */
void board_wifi_stop_ap(void) {
    if (s_wifi_started) {
        esp_wifi_stop();
    }
}

/**
 * The access point's address.
 *
 * The default ESP-IDF access point uses 192.168.4.1.
 */
const char *board_ap_address(void) {
    return "192.168.4.1";
}

/**
 * Store Wi-Fi credentials.
 */
esp_err_t board_set_wifi_credentials(const char *ssid, const char *password) {
    nvs_handle_t nvs;
    ESP_ERROR_CHECK(nvs_open("paperloom", NVS_READWRITE, &nvs));
    ESP_ERROR_CHECK(nvs_set_str(nvs, "wifi_ssid", ssid));
    ESP_ERROR_CHECK(nvs_set_str(nvs, "wifi_pass", password));
    ESP_ERROR_CHECK(nvs_commit(nvs));
    nvs_close(nvs);
    return ESP_OK;
}

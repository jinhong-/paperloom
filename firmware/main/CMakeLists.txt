# The main firmware.
#
# The display driver lives in main/ rather than in a component because it
# is specific to this board and shares the panel constants in app_config.h
# with the rest of the firmware.

idf_component_register(
    SRCS
        "main.c"
        "board.c"
        "crypto.c"
        "display_task.c"
        "epaper_driver.c"
        "power.c"
        "schedule.c"
        "storage.c"
        "sync.c"
        "time.c"
        "utils.c"
    INCLUDE_DIRS
        "."
    REQUIRES
        esp_wifi
        esp_netif
        esp_event
        esp_timer
        nvs_flash
        fatfs
        sdmmc
        esp_driver_sdspi
        esp_driver_spi
        esp_http_client
        cjson
        zlib
        mbedtls
        esp_hw_support
)

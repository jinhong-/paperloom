# The main firmware.
#
# The display driver lives in main/ rather than in a component because it
# is specific to this board and shares the panel constants in app_config.h
# with the rest of the firmware.

# The version the firmware reports comes from version.txt, which is the
# file the release process keeps up to date. Reading it here means the
# firmware and the release cannot say different things about which
# version they are.
file(READ "${CMAKE_CURRENT_LIST_DIR}/../version.txt" FIRMWARE_VERSION)
string(STRIP "${FIRMWARE_VERSION}" FIRMWARE_VERSION)

idf_component_register(
    SRCS
        "main.c"
        "board.c"
        "crypto.c"
        "display_task.c"
        "drawing.c"
        "epaper_driver.c"
        "font_ascii.c"
        "power.c"
        "qr.c"
        "schedule.c"
        "setup_mode.c"
        "setup_screen.c"
        "setup_server.c"
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
        spiffs
        sdmmc
        esp_driver_sdspi
        esp_driver_spi
        esp_http_client
        esp_http_server
        cjson
        zlib
        mbedtls
        qrcode
        esp_hw_support
        esp_pm
)

# The version the firmware reports comes from version.txt, which is the
# file the release process keeps up to date. Reading it here means the
# firmware and the release cannot say different things about which
# version they are.
target_compile_definitions(${COMPONENT_LIB} PRIVATE
    APP_VERSION="${FIRMWARE_VERSION}"
)

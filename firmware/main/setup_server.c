/*
 * The setup web server.
 *
 * While the frame is in setup mode it runs a small HTTP server on its
 * access point. The page it serves asks for the home Wi-Fi details and
 * the server URL, then posts them back.
 *
 * The page is a single HTML string rather than a set of files. The frame
 * is serving it, and every byte of flash matters; there is also no file
 * system to read it from when the SD card is not present, which is the
 * normal case during setup.
 */

#include <stdio.h>
#include <string.h>

#include "cJSON.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include "board.h"
#include "setup_server.h"
#include "sync.h"

static const char *TAG = "setup_server";

/**
 * The setup page.
 *
 * It is deliberately plain: one stylesheet inline, no scripts beyond the
 * form submission, and no external requests. The phone is on a network
 * with no route to the internet, so anything external would simply fail.
 */
static const char SETUP_PAGE[] =
    "<!DOCTYPE html>\n"
    "<html lang=\"en\">\n"
    "<head>\n"
    "<meta charset=\"utf-8\">\n"
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n"
    "<title>Paperloom setup</title>\n"
    "<style>\n"
    "body{font-family:system-ui,sans-serif;background:#12100e;color:#f0ebe3;"
    "margin:0;padding:24px;line-height:1.5}\n"
    ".card{max-width:480px;margin:0 auto;background:#1b1815;border:1px solid #3a332b;"
    "border-radius:10px;padding:24px}\n"
    "h1{font-size:22px;margin:0 0 6px}\n"
    "h1 span{color:#d8a657}\n"
    "p.sub{color:#a89f92;margin:0 0 24px;font-size:14px}\n"
    "label{display:block;font-size:13px;color:#a89f92;margin:0 0 6px}\n"
    "input{width:100%;box-sizing:border-box;background:#12100e;border:1px solid #3a332b;"
    "color:#f0ebe3;border-radius:8px;padding:10px 12px;font-size:15px;margin:0 0 18px;"
    "font-family:inherit}\n"
    "input:focus{outline:none;border-color:#8a6a37}\n"
    "button{width:100%;background:#d8a657;color:#1a1409;border:none;border-radius:8px;"
    "padding:12px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer}\n"
    "button:disabled{opacity:.5}\n"
    ".msg{margin-top:18px;padding:12px 14px;border-radius:8px;font-size:14px;display:none}\n"
    ".msg.ok{background:#1a2419;border:1px solid #35502f;color:#7fbf7f;display:block}\n"
    ".msg.err{background:#2a1a19;border:1px solid #57302c;color:#f0b3ad;display:block}\n"
    ".note{font-size:13px;color:#a89f92;margin-top:16px}\n"
    "</style>\n"
    "</head>\n"
    "<body>\n"
    "<div class=\"card\">\n"
    "<h1>Paper<span>loom</span></h1>\n"
    "<p class=\"sub\">Set up this frame. It needs your home Wi-Fi and the address of "
    "your Paperloom server.</p>\n"
    "<form id=\"f\">\n"
    "<label for=\"ssid\">Home Wi-Fi name</label>\n"
    "<input id=\"ssid\" name=\"ssid\" required autocapitalize=\"none\" "
    "autocorrect=\"off\" spellcheck=\"false\">\n"
    "<label for=\"pass\">Home Wi-Fi password</label>\n"
    "<input id=\"pass\" name=\"password\" type=\"password\" "
    "autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\">\n"
    "<label for=\"url\">Server URL</label>\n"
    "<input id=\"url\" name=\"server_url\" required placeholder=\"https://paperloom.example.com\" "
    "autocapitalize=\"none\" autocorrect=\"off\" spellcheck=\"false\">\n"
    "<button id=\"go\" type=\"submit\">Save and connect</button>\n"
    "</form>\n"
    "<div id=\"msg\" class=\"msg\"></div>\n"
    "<p class=\"note\">The server address is required: Paperloom is self-hosted, so "
    "there is no default.</p>\n"
    "</div>\n"
    "<script>\n"
    "var f=document.getElementById('f'),m=document.getElementById('msg'),b=document.getElementById('go');\n"
    "f.addEventListener('submit',function(e){\n"
    "e.preventDefault();b.disabled=true;m.className='msg';\n"
    "var d={ssid:document.getElementById('ssid').value,"
    "password:document.getElementById('pass').value,"
    "server_url:document.getElementById('url').value};\n"
    "fetch('/api/setup',{method:'POST',headers:{'Content-Type':'application/json'},"
    "body:JSON.stringify(d)}).then(function(r){return r.json().then(function(j){"
    "return {ok:r.ok,j:j};});}).then(function(r){\n"
    "if(r.ok){m.className='msg ok';m.textContent=r.j.message||'Saved. The frame is "
    "connecting.';b.textContent='Saved';}\n"
    "else{m.className='msg err';m.textContent=r.j.error||'Could not save those details.';"
    "b.disabled=false;}\n"
    "}).catch(function(){m.className='msg err';"
    "m.textContent='The frame did not answer. Is it still on the Paperloom network?';"
    "b.disabled=false;});\n"
    "});\n"
    "</script>\n"
    "</body>\n"
    "</html>\n";

/**
 * Send a response with the right content type.
 */
static esp_err_t send_html(httpd_req_t *req, const char *html) {
    httpd_resp_set_type(req, "text/html; charset=utf-8");
    /* The content length is left to the server: setting it to zero tells
     * the client the body is empty, and the page arrives blank. */
    return httpd_resp_send(req, html, HTTPD_RESP_USE_STRLEN);
}

/**
 * Serve the setup page.
 */
static esp_err_t get_setup_page(httpd_req_t *req) {
    ESP_LOGI(TAG, "Serving the setup page");
    return send_html(req, SETUP_PAGE);
}

/**
 * Accept the configuration.
 *
 * The values are stored, then the frame tries to connect to the home
 * network. The reply says what happened, so the page can tell the user.
 */
static esp_err_t post_setup(httpd_req_t *req) {
    char body[1024];
    int received = 0;

    while (received < (int)sizeof(body) - 1) {
        int len = httpd_req_recv(req, body + received, sizeof(body) - 1 - received);
        if (len <= 0) {
            if (len == HTTPD_SOCK_ERR_TIMEOUT) {
                continue;
            }
            break;
        }
        received += len;
    }
    body[received] = '\0';

    cJSON *root = cJSON_Parse(body);
    if (root == NULL) {
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req, "{\"error\":\"That was not understood. Please try again.\"}");
        return ESP_OK;
    }

    cJSON *ssid = cJSON_GetObjectItem(root, "ssid");
    cJSON *password = cJSON_GetObjectItem(root, "password");
    cJSON *server_url = cJSON_GetObjectItem(root, "server_url");

    if (!cJSON_IsString(ssid) || !cJSON_IsString(server_url) || ssid->valuestring[0] == '\0' ||
        server_url->valuestring[0] == '\0') {
        cJSON_Delete(root);
        httpd_resp_set_type(req, "application/json");
        httpd_resp_sendstr(req,
                           "{\"error\":\"The Wi-Fi name and the server address are both "
                           "needed.\"}");
        return ESP_OK;
    }

    const char *wifi_password = cJSON_IsString(password) ? password->valuestring : "";

    /* Store the settings. They take effect on the next boot, and the
     * frame reboots itself so that the change is immediate. */
    esp_err_t err = setup_apply(server_url->valuestring, ssid->valuestring, wifi_password);
    cJSON_Delete(root);

    httpd_resp_set_type(req, "application/json");

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not store the settings: %s", esp_err_to_name(err));
        httpd_resp_sendstr(req, "{\"error\":\"Those details could not be saved. Please try "
                                "again.\"}");
        return ESP_OK;
    }

    ESP_LOGI(TAG, "Settings stored; restarting");
    httpd_resp_sendstr(req,
                       "{\"message\":\"Saved. The frame is restarting and will connect to "
                       "your Wi-Fi.\"}");

    /* Give the reply a moment to reach the phone, then restart. The frame
     * has to restart because the radio is configured for the access point
     * and has to be reconfigured for the home network. */
    vTaskDelay(pdMS_TO_TICKS(1500));
    setup_restart();

    return ESP_OK;
}

/**
 * Report the frame's identity, so the setup page can show it.
 */
static esp_err_t get_status(httpd_req_t *req) {
    char json[256];
    snprintf(json, sizeof(json),
             "{\"device_id\":\"%s\",\"hostname\":\"%s\",\"firmware\":\"%s\"}",
             setup_device_id(), setup_hostname(), setup_firmware_version());

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    return ESP_OK;
}

/**
 * Start the setup web server.
 */
esp_err_t setup_server_start(httpd_handle_t *out_handle) {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 8;
    config.stack_size = 4096;
    /* The setup page is a single small document; there is nothing else to
     * serve. */
    config.lru_purge_enable = true;

    httpd_handle_t handle = NULL;
    esp_err_t err = httpd_start(&handle, &config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not start the setup server: %s", esp_err_to_name(err));
        return err;
    }

    httpd_uri_t root = {
        .uri = "/",
        .method = HTTP_GET,
        .handler = get_setup_page,
    };
    httpd_register_uri_handler(handle, &root);

    httpd_uri_t api = {
        .uri = "/api/setup",
        .method = HTTP_POST,
        .handler = post_setup,
    };
    httpd_register_uri_handler(handle, &api);

    httpd_uri_t status = {
        .uri = "/api/status",
        .method = HTTP_GET,
        .handler = get_status,
    };
    httpd_register_uri_handler(handle, &status);

    *out_handle = handle;
    ESP_LOGI(TAG, "The setup server is listening");
    return ESP_OK;
}

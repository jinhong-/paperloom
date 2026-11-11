<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type Device, type ScheduleItem } from "@/api";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();

const selected = ref<Device | null>(null);
const schedule = ref<ScheduleItem[]>([]);
const scheduleRevision = ref("");
const error = ref<string | null>(null);

const syncInterval = ref(3600);
const lookahead = ref(10800);
const timezone = ref("UTC");

const deviceGalleries = ref<Set<number>>(new Set());

/**
 * Load the schedule for the selected device.
 */
async function showSchedule(device: Device): Promise<void> {
  selected.value = device;
  schedule.value = [];
  error.value = null;
  try {
    const result = await api.schedule(device.id);
    schedule.value = result.items;
    scheduleRevision.value = result.revision;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Save the device's sync policy.
 */
async function savePolicy(): Promise<void> {
  if (!selected.value) return;
  error.value = null;
  try {
    await api.updatePolicy(selected.value.id, {
      sync_interval: syncInterval.value,
      lookahead: lookahead.value,
      timezone: timezone.value,
    });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Assign a gallery to the device.
 */
async function toggleGallery(galleryId: number, assigned: boolean): Promise<void> {
  if (!selected.value) return;
  error.value = null;
  try {
    if (assigned) {
      await api.assignGallery(selected.value.id, galleryId);
      deviceGalleries.value.add(galleryId);
    } else {
      await api.unassignGallery(selected.value.id, galleryId);
      deviceGalleries.value.delete(galleryId);
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function removeDevice(device: Device): Promise<void> {
  if (!confirm(`Remove "${device.name}"? The frame will need to be claimed again.`)) return;
  error.value = null;
  try {
    await api.deleteDevice(device.id);
    if (selected.value?.id === device.id) {
      selected.value = null;
      schedule.value = [];
    }
    await session.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Format a timestamp for display.
 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * Describe how long ago a timestamp was.
 */
function formatSeen(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}

const batteryPercent = computed(() => {
  const mv = selected.value?.battery_mv;
  if (!mv) return null;
  // A rough LiPo curve between 3.0 V and 4.2 V.
  return Math.max(0, Math.min(100, Math.round(((mv - 3000) / 1200) * 100)));
});

onMounted(async () => {
  await session.reload();
});
</script>

<template>
  <h1>Devices</h1>
  <p class="subtitle">
    Frames check in on their own schedule. They cannot be woken remotely.
  </p>

  <div v-if="session.error" class="error">{{ session.error }}</div>
  <div v-if="error" class="error">{{ error }}</div>

  <div class="grid-2">
    <div>
      <h2>Frames</h2>

      <div v-if="session.loading" class="empty">Loading...</div>
      <div v-else-if="session.devices.length === 0" class="empty">
        No frames yet. Set one up and enter the claim code it shows.
      </div>

      <div v-for="device in session.devices" :key="device.id" class="card">
        <div class="row between">
          <div class="grow">
            <strong>{{ device.name }}</strong>
            <div class="small muted">
              {{ device.panel_width }}×{{ device.panel_height }} ·
              seen {{ formatSeen(device.last_seen_at) }}
            </div>
          </div>
          <span class="tag" :class="device.state">{{ device.state }}</span>
          <button class="secondary" @click="showSchedule(device)">Schedule</button>
          <button class="danger" @click="removeDevice(device)">Remove</button>
        </div>
      </div>
    </div>

    <div v-if="selected">
      <h2>{{ selected.name }}</h2>

      <div class="card">
        <h2>State</h2>
        <table>
          <tbody>
            <tr>
              <td class="muted">Device id</td>
              <td class="mono">{{ selected.device_id }}</td>
            </tr>
            <tr>
              <td class="muted">Firmware</td>
              <td>{{ selected.firmware_version ?? "unknown" }}</td>
            </tr>
            <tr>
              <td class="muted">Battery</td>
              <td>
                <template v-if="selected.battery_mv">
                  {{ selected.battery_mv }} mV
                  <span class="muted">({{ batteryPercent }}%)</span>
                </template>
                <template v-else>
                  <span class="muted">not reported</span>
                </template>
              </td>
            </tr>
            <tr>
              <td class="muted">Showing</td>
              <td class="mono">
                <template v-if="selected.displayed_asset">
                  {{ selected.displayed_asset.slice(0, 16) }}…
                </template>
                <template v-else>
                  <span class="muted">unknown</span>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Check-in policy</h2>
        <div class="field">
          <label for="sync-interval">Check in every (seconds)</label>
          <input id="sync-interval" v-model.number="syncInterval" type="number" min="60" />
        </div>
        <div class="field">
          <label for="lookahead">Schedule lookahead (seconds)</label>
          <input id="lookahead" v-model.number="lookahead" type="number" min="3600" />
          <div class="small muted">
            How far ahead the server plans the display events. A longer window
            survives a failed check-in.
          </div>
        </div>
        <div class="field">
          <label for="timezone">Time zone</label>
          <input id="timezone" v-model="timezone" placeholder="Europe/Berlin" />
        </div>
        <button @click="savePolicy">Save policy</button>
      </div>

      <div class="card">
        <h2>Galleries</h2>
        <div v-if="session.galleries.length === 0" class="empty">No galleries yet.</div>
        <div v-for="item in session.galleries" :key="item.id" class="row between">
          <span>{{ item.name }}</span>
          <button
            class="secondary"
            @click="toggleGallery(item.id, !deviceGalleries.has(item.id))"
          >
            {{ deviceGalleries.has(item.id) ? "Assigned" : "Assign" }}
          </button>
        </div>
      </div>

      <div class="card">
        <h2>Upcoming schedule</h2>
        <div class="small muted" style="margin-bottom: 12px">
          Revision <span class="mono">{{ scheduleRevision }}</span>
        </div>

        <div v-if="schedule.length === 0" class="empty">
          No events. Assign a gallery with photos.
        </div>

        <div v-else class="schedule-list">
          <div v-for="(item, index) in schedule.slice(0, 24)" :key="index" class="schedule-item">
            <strong style="min-width: 120px">{{ formatTime(item.at) }}</strong>
            <span class="mono muted">{{ item.asset.slice(0, 20) }}…</span>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="empty">Select a frame to see its state and schedule.</div>
  </div>
</template>

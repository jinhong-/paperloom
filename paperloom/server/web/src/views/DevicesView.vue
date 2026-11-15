<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type Device, type ScheduleItem, type SyncRule } from "@/api";
import { DAY_NAMES, DAY_SHORT } from "@/lib/dayNames";
import {
  countWithUnit,
  describeDays,
  describeInterval,
  daysMask,
  formatMinute,
  parseMinute,
} from "@/lib/syncRules";
import { availableTimeZones, browserTimeZone, timeZoneLabel } from "@/lib/timezones";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();

const selected = ref<Device | null>(null);
const schedule = ref<ScheduleItem[]>([]);

/* When the plan is to change, and what it will become.
 *
 * A frame is given the plan it is already following until its next
 * check-in, so that the times on this page and the times the frame is
 * working to are the same. The owner is shown what the plan will become,
 * so that the effect of a change can be seen before it happens. */
const handoverAt = ref<string | null>(null);
const projected = ref<ScheduleItem[]>([]);

const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/* The code a frame shows while it waits to be claimed. */
const claimCode = ref("");

/* What the frame is doing, and whether it is working on it.
 *
 * A frame only checks in every so often, so a change does not show up on
 * the panel straight away. Saying what is happening is the only way to
 * show that the button did something. */
const busy = ref<string | null>(null);

const syncInterval = ref(3600);
const lookahead = ref(10800);
const timezone = ref("UTC");

/* How the frame is mounted.
 *
 * A frame that hangs turned shows its pictures turned, so the pictures are
 * prepared for it turned too. */
const rotation = ref(0);

/* Check-in rules. */
const rules = ref<SyncRule[]>([]);
/* The rule being written. */
const ruleDays = ref<number[]>([0, 1, 2, 3, 4, 5, 6]);
const ruleStart = ref("08:00");
const ruleEnd = ref("22:00");
const ruleInterval = ref(300);

/** The time zones the browser knows about. */
const timeZones = availableTimeZones();

/** The browser's own zone, offered as the obvious default. */
const browserZone = browserTimeZone();

/**
 * Load the schedule for the selected device.
 */
async function showSchedule(device: Device): Promise<void> {
  selected.value = device;
  schedule.value = [];
  handoverAt.value = null;
  projected.value = [];
  error.value = null;
  notice.value = null;

  /* The gallery and the policy come with the frame, so that what is
   * shown is what the frame is actually doing rather than a guess. */
  if (device.policy) {
    syncInterval.value = device.policy.sync_interval;
    lookahead.value = device.policy.lookahead;
  }
  timezone.value = device.timezone;
  rotation.value = device.rotation ?? 0;

  try {
    const result = await api.schedule(device.id);
    schedule.value = result.items;
    handoverAt.value = result.handover_at;
    projected.value = result.projected ?? [];
    rules.value = await api.syncRules(device.id);
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
  notice.value = null;
  busy.value = "Saving the policy...";
  try {
    await api.updatePolicy(selected.value.id, {
      sync_interval: syncInterval.value,
      lookahead: lookahead.value,
      timezone: timezone.value,
      rotation: rotation.value,
    });
    notice.value = "Policy saved.";
    busy.value = "Policy saved. The frame picks it up at its next check-in.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    busy.value = null;
  }
}

/**
 * Use the browser's own time zone.
 */
function useBrowserZone(): void {
  timezone.value = browserZone;
}

/**
 * Choose the gallery the frame shows.
 *
 * A frame shows one gallery, so choosing another one replaces the one it
 * had. Choosing none leaves it showing nothing.
 */
async function chooseGallery(galleryId: number | null): Promise<void> {
  if (!selected.value) return;
  error.value = null;
  busy.value = galleryId === null ? "Removing the gallery..." : "Setting the gallery...";
  try {
    if (galleryId === null) {
      const current = selected.value.gallery_id;
      if (current === null) return;
      await api.unassignGallery(selected.value.id, current);
      selected.value.gallery_id = null;
      busy.value = "The frame shows nothing now. It picks this up at its next check-in.";
    } else {
      await api.assignGallery(selected.value.id, galleryId);
      selected.value.gallery_id = galleryId;
      busy.value = "The gallery was set. The frame picks it up at its next check-in.";
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    busy.value = null;
  }
}

/**
 * Claim a frame with the code it shows.
 *
 * The code is the owner's proof that the frame is theirs, so it is what
 * the frame is found by.
 */
async function claimWithCode(): Promise<void> {
  if (claimCode.value.trim() === "") return;
  error.value = null;
  notice.value = null;
  busy.value = "Claiming the frame...";
  try {
    await api.claimDevice(claimCode.value);
    claimCode.value = "";
    notice.value = "The frame is yours now. It will pick up its pictures at its next check-in.";
    await session.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = null;
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
      handoverAt.value = null;
      projected.value = [];
      rules.value = [];
    }
    await session.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Add a check-in rule.
 */
async function addRule(): Promise<void> {
  if (!selected.value) return;

  const start = parseMinute(ruleStart.value);
  const end = parseMinute(ruleEnd.value);
  if (start === null || end === null) {
    error.value = "The times must look like 08:00.";
    return;
  }
  if (ruleInterval.value < 60) {
    error.value = "The interval must be at least a minute.";
    return;
  }

  error.value = null;
  notice.value = null;
  try {
    await api.createSyncRule(selected.value.id, {
      days: daysMask(ruleDays.value),
      start_minute: start,
      end_minute: end,
      sync_interval: ruleInterval.value,
    });
    rules.value = await api.syncRules(selected.value.id);
    notice.value = "Rule added.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function removeRule(rule: SyncRule): Promise<void> {
  if (!selected.value) return;
  error.value = null;
  try {
    await api.deleteSyncRule(selected.value.id, rule.id);
    rules.value = await api.syncRules(selected.value.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Format a timestamp for display.
 *
 * The time is in the frame's own time zone, because that is the zone its
 * rules are written in: a rule that says 08:00 means eight in the
 * morning where the frame is, so the times of the pictures it is given
 * have to be shown in that same zone to match.
 *
 * The time is always in the 24-hour form, whatever the browser's locale
 * says, so that it matches the times the rules are written in.
 */
function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    timeZone: timezone.value,
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/**
 * Describe how long ago a timestamp was.
 *
 * The units are spelled out in the same way as the intervals of the rules,
 * so that the page reads as one piece of English.
 */
function formatSeen(iso: string | null): string {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${countWithUnit(Math.round(seconds / 60), "minute")} ago`;
  if (seconds < 86400) return `${countWithUnit(Math.round(seconds / 3600), "hour")} ago`;
  return `${countWithUnit(Math.round(seconds / 86400), "day")} ago`;
}

/**
 * Whether a time field holds a clock time we understand.
 *
 * The fields are free text so that the clock is always 24-hour, whatever
 * the browser's locale says. A native time picker would show "10:00 pm"
 * next to the "08:00-22:00" of the rule list above it.
 */
function timeIsValid(text: string): boolean {
  return parseMinute(text) !== null;
}

/**
 * Normalise a time field once it is edited.
 *
 * "8:5" becomes "08:05", so that the field shows the same thing the rule
 * list shows.
 */
function normaliseTime(text: string): string {
  const minute = parseMinute(text);
  return minute === null ? text : formatMinute(minute);
}

const batteryPercent = computed(() => {
  const mv = selected.value?.battery_mv;
  if (!mv) return null;
  // A rough LiPo curve between 3.0 V and 4.2 V.
  return Math.max(0, Math.min(100, Math.round(((mv - 3000) / 1200) * 100)));
});

/**
 * The rules, in a form that is easy to read.
 */
const describedRules = computed(() =>
  rules.value.map((rule) => {
    const daysText = describeDays(rule.days);
    return {
      ...rule,
      daysText,
      startText: formatMinute(rule.start_minute),
      endText: formatMinute(rule.end_minute),
      intervalText: describeInterval(rule.sync_interval),
      /* The times and the interval as one string, so that they are
       * separated from the days by a space. Whitespace written between two
       * elements of a template is condensed away, and "Every day" would
       * otherwise run into the time that follows it. */
      detailText: ` ${formatMinute(rule.start_minute)}–${formatMinute(rule.end_minute)} · every ${describeInterval(rule.sync_interval)}`,
    };
  }),
);

onMounted(async () => {
  await session.reload();
  timezone.value = browserZone;
});
</script>

<template>
  <h1>Devices</h1>
  <p class="subtitle">
    Frames check in on their own schedule. They cannot be woken remotely.
  </p>

  <div v-if="session.error" class="error">{{ session.error }}</div>
  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="notice" class="ok">{{ notice }}</div>

  <div class="grid-2">
    <div>
      <h2>Frames</h2>

      <div v-if="session.loading" class="empty">Loading...</div>

      <div v-else class="card">
        <h3>Claim a frame</h3>
        <p class="small muted">
          A frame that has just set itself up has a code on it. Type the
          code here and the frame is yours.
        </p>
        <div class="row">
          <div class="field grow">
            <label for="claim-code">The code on the frame</label>
            <input
              id="claim-code"
              v-model="claimCode"
              placeholder="S7TQ-K25V-PJRR"
              @keyup.enter="claimWithCode"
            />
          </div>
          <div class="field" style="align-self: flex-end">
            <button :disabled="busy !== null || claimCode.trim() === ''" @click="claimWithCode">
              Claim it
            </button>
          </div>
        </div>
      </div>

      <div v-if="session.devices.length === 0" class="empty">
        No frames yet. Set one up and type the code it shows above.
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
            <tr>
              <td class="muted">Mounted</td>
              <td>
                <select id="rotation" v-model.number="rotation" @change="savePolicy">
                  <option v-for="angle in [0, 90, 180, 270]" :key="angle" :value="angle">
                    {{ angle === 0 ? "upright" : `turned ${angle}°` }}
                  </option>
                </select>
                <div class="small muted">
                  How the frame hangs. A frame that hangs turned shows its
                  pictures turned, so they are prepared that way.
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div class="card">
        <h2>Check-in policy</h2>
        <p class="small muted">
          A frame does not need to check in at the same rate all day. During the
          hours when somebody is around it can be responsive; overnight it can
          save power by waiting.
        </p>

        <div class="field">
          <label for="timezone">Time zone</label>
          <select id="timezone" v-model="timezone">
            <option v-for="zone in timeZones" :key="zone" :value="zone">
              {{ timeZoneLabel(zone) }}
            </option>
          </select>
          <button class="secondary" @click="useBrowserZone">
            Use this computer's zone ({{ browserZone }})
          </button>
          <div class="small muted">
            The frame's clock is kept in this zone when it plans what to show.
          </div>
        </div>

        <div class="field">
          <label for="lookahead">Schedule lookahead (seconds)</label>
          <input id="lookahead" v-model.number="lookahead" type="number" min="3600" />
          <div class="small muted">
            How far ahead the server plans the display events. A longer window
            survives a failed check-in, and the plan stays the same for longer.
            That is {{ describeInterval(lookahead) }} of planned events.
          </div>
        </div>

        <h3>Rules</h3>
        <div class="small muted">
          A rule says how often the frame checks in while it applies. When two
          rules cover the same moment, the more specific one wins: a rule for
          weekdays beats one for every day.
        </div>

        <div v-if="describedRules.length === 0" class="empty">
          No rules. The frame has nothing to check in for, so it will stay
          asleep. Add a rule to wake it up.
        </div>

        <div
          v-for="rule in describedRules"
          :key="rule.id"
          class="row between"
          style="padding: 8px 0; border-bottom: 1px solid var(--line)"
        >
          <div>
            <strong>{{ rule.daysText }}</strong>
            <span class="muted">{{ rule.detailText }}</span>
          </div>
          <button class="danger" @click="removeRule(rule)">Remove</button>
        </div>

        <h3 style="margin-top: 20px">Add a rule</h3>
        <div class="field">
          <label>Days</label>
          <div class="row" style="gap: 4px; flex-wrap: wrap">
            <button
              v-for="(name, day) in DAY_NAMES"
              :key="day"
              class="secondary day-toggle"
              :class="{ 'is-selected': ruleDays.includes(day) }"
              :title="name"
              @click="ruleDays = ruleDays.includes(day)
                ? ruleDays.filter(d => d !== day)
                : [...ruleDays, day].sort()"
            >
              {{ DAY_SHORT[day] }}
            </button>
          </div>
          <div class="small muted">
            {{ describeDays(daysMask(ruleDays)) }}
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="rule-start">From</label>
            <input
              id="rule-start"
              v-model="ruleStart"
              type="text"
              inputmode="numeric"
              placeholder="08:00"
              maxlength="5"
              :class="{ invalid: !timeIsValid(ruleStart) }"
              @blur="ruleStart = normaliseTime(ruleStart)"
            />
          </div>
          <div class="field">
            <label for="rule-end">Until</label>
            <input
              id="rule-end"
              v-model="ruleEnd"
              type="text"
              inputmode="numeric"
              placeholder="22:00"
              maxlength="5"
              :class="{ invalid: !timeIsValid(ruleEnd) }"
              @blur="ruleEnd = normaliseTime(ruleEnd)"
            />
          </div>
        </div>
        <div class="small muted">
          The clock is 24-hour, the same as the times in the rules above.
        </div>
        <div class="field">
          <label for="rule-interval">Check in every (seconds)</label>
          <input id="rule-interval" v-model.number="ruleInterval" type="number" min="60" />
          <div class="small muted">That is every {{ describeInterval(ruleInterval) }}.</div>
        </div>
        <button @click="addRule">Add rule</button>

        <hr style="margin: 24px 0; border: 0; border-top: 1px solid var(--line)" />

        <button @click="savePolicy" :disabled="busy !== null">
          {{ busy !== null ? "Working..." : "Save policy" }}
        </button>
        <p v-if="busy" class="small muted">{{ busy }}</p>
      </div>

      <div class="card">
        <h2>Gallery</h2>
        <p class="small muted">
          A frame shows one gallery. The pictures in it, and the schedule
          that says when they change, are the gallery's.
        </p>

        <div v-if="session.galleries.length === 0" class="empty">
          No galleries yet. Make one first.
        </div>

        <template v-else>
          <div class="field">
            <label for="device-gallery">The gallery this frame shows</label>
            <select
              id="device-gallery"
              :value="selected?.gallery_id ?? ''"
              @change="chooseGallery(Number(($event.target as HTMLSelectElement).value))"
            >
              <option value="">None</option>
              <option v-for="item in session.galleries" :key="item.id" :value="item.id">
                {{ item.name }}
              </option>
            </select>
          </div>

          <button
            v-if="selected?.gallery_id"
            class="secondary"
            :disabled="busy !== null"
            @click="chooseGallery(null)"
          >
            Show nothing
          </button>
        </template>
      </div>

      <div class="card">
        <h2>Upcoming schedule</h2>
        <p class="small muted">
          The photos this frame will show, and when. The frame is told this
          list at each check-in, so a change here takes effect the next time
          it wakes up. The times are in the frame's own time zone,
          {{ timeZoneLabel(timezone) }}, which is the zone its rules are
          written in. The list reaches as far as the frame's next check-in
          plus the lookahead, so there is always something to show even if a
          check-in fails.
        </p>

        <div v-if="schedule.length === 0" class="empty">
          No events. Assign a gallery with photos.
        </div>

        <div v-else class="schedule-list">
          <div v-for="(item, index) in schedule" :key="index" class="schedule-item">
            <div
              v-if="item.photo_id"
              class="photo-preview photo-preview-small"
            >
              <img :src="api.photoPreviewUrl(item.photo_id)" :alt="item.filename ?? ''" loading="lazy" />
            </div>
            <strong style="min-width: 130px">{{ formatTime(item.at) }}</strong>
            <span class="grow">{{ item.filename ?? "unknown photo" }}</span>
          </div>
        </div>

        <!-- The plan is waiting to change. -->
        <div v-if="handoverAt" class="card" style="margin-top: 16px">
          <h3>Waiting for the frame's next check-in</h3>
          <p class="small muted">
            The frame is still working to the list above, and will keep
            working to it until it checks in at
            <strong>{{ formatTime(handoverAt) }}</strong>. At that point it
            is given the list below, and the times above stop applying.
          </p>

          <div v-if="projected.length === 0" class="empty">
            The new list is empty. The frame will show nothing until the
            gallery has photos again.
          </div>

          <div v-else class="schedule-list">
            <div v-for="(item, index) in projected" :key="index" class="schedule-item">
              <div
                v-if="item.photo_id"
                class="photo-preview photo-preview-small"
              >
                <img :src="api.photoPreviewUrl(item.photo_id)" :alt="item.filename ?? ''" loading="lazy" />
              </div>
              <strong style="min-width: 130px">{{ formatTime(item.at) }}</strong>
              <span class="grow">{{ item.filename ?? "unknown photo" }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-else class="empty">Select a frame to see its state and schedule.</div>
  </div>
</template>

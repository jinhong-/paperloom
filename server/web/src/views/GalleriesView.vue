<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import {
  api,
  type Gallery,
  type GalleryScheduleRule,
  type Photo,
  TONE_PRESETS,
} from "@/api";
import GallerySchedule, { type DraftRule } from "@/components/GallerySchedule.vue";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();

const selected = ref<Gallery | null>(null);
const photos = ref<Photo[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/* The rules that say when this gallery changes its picture. */
const rules = ref<GalleryScheduleRule[]>([]);

/* Whether the gallery changes its picture on its own. */
const scheduleEnabled = ref(true);

/* The picture the gallery shows when it is off. */
const manualPhotoId = ref<number | null>(null);

/* How the pictures from a chat arrive. */
const telegramMode = ref<"queue" | "latest">("queue");

const newName = ref("");

/* The schedule of a gallery being made, using the same editor as an
 * existing one. */
const newEnabled = ref(true);
const newRules = ref<DraftRule[]>([]);

const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

/** The photos whose original could not be loaded, so a placeholder is shown. */
const missingPreviews = ref<Set<number>>(new Set());

const gallery = computed(() => selected.value);

/**
 * Load the photos of the selected gallery, and the rules that say when
 * it changes.
 */
async function selectGallery(target: Gallery): Promise<void> {
  selected.value = target;
  photos.value = [];
  missingPreviews.value = new Set();
  error.value = null;
  scheduleEnabled.value = target.schedule_enabled === 1;
  telegramMode.value = target.telegram_mode === "latest" ? "latest" : "queue";
  manualPhotoId.value = target.manual_photo_id ?? null;
  try {
    photos.value = await api.photos(target.id);
    rules.value = await api.galleryScheduleRules(target.id);
    loadDrafts(rules.value);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Save the gallery's settings.
 */
async function saveGallery(body: Partial<Gallery>): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.updateGallery(selected.value.id, body);
    const updated = session.galleries.find((g) => g.id === selected.value?.id);
    if (updated) {
      Object.assign(updated, body);
    }
    notice.value = "Saved. The frame will pick it up at its next check-in.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * The rules as the editor holds them.
 *
 * The editor works in the owner's terms: which days, and how often. The
 * server works in seconds, so the two are converted here.
 *
 * The editor holds the rules while they are being written, and the
 * server's copy is the one that is saved. The two are kept in step by
 * loading the server's rules into the editor whenever the gallery
 * changes.
 */
const draftRules = ref<DraftRule[]>([]);

/**
 * Load the rules into the editor, in the owner's terms.
 */
function loadDrafts(from: GalleryScheduleRule[]): void {
  draftRules.value = from.map((rule) => ({
    id: rule.id,
    days: rule.days,
    startMinute: rule.start_minute,
    endMinute: rule.end_minute,
    intervalSeconds:
      rule.min_interval === null && rule.max_interval === null
        ? null
        : (rule.max_interval ?? rule.min_interval ?? 0),
    rotationMode: rule.rotation_mode,
  }));
}

/**
 * The rules in the editor have changed, so they are saved.
 *
 * The editor holds the rules while they are written, and the server's
 * copy is the one that is saved. The editor is given the server's copy
 * back afterwards, so that the two are the same.
 */
async function onRulesChanged(drafts: DraftRule[]): Promise<void> {
  draftRules.value = drafts;
  await saveRules(drafts);
}

/**
 * Save the rules the editor holds.
 *
 * The whole set is saved, because the editor holds all of it and the
 * rules are not ordered by anything that matters: which rule wins where
 * they overlap is worked out from their priority.
 */
async function saveRules(drafts: DraftRule[]): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    /* The rules that are gone are removed, and the ones that are left
     * are added or changed. */
    const kept = new Set(drafts.map((rule) => rule.id).filter((id) => id !== undefined));

    for (const rule of rules.value) {
      if (!kept.has(rule.id)) {
        await api.removeGalleryScheduleRule(selected.value.id, rule.id);
      }
    }

    for (const draft of drafts) {
      const body = {
        days: draft.days,
        start_minute: draft.startMinute,
        end_minute: draft.endMinute,
        min_interval: draft.intervalSeconds,
        max_interval: draft.intervalSeconds,
        rotation_mode: draft.rotationMode,
      };

      if (draft.id === undefined) {
        await api.addGalleryScheduleRule(selected.value.id, body);
      } else {
        await api.updateGalleryScheduleRule(selected.value.id, draft.id, body);
      }
    }

    rules.value = await api.galleryScheduleRules(selected.value.id);
    loadDrafts(rules.value);
    notice.value = "The schedule was saved. The frame picks it up at its next check-in.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Turn the schedule on or off.
 */
async function setScheduleEnabled(enabled: boolean): Promise<void> {
  scheduleEnabled.value = enabled;
  await saveGallery({ schedule_enabled: enabled ? 1 : 0 });
}

/**
 * Set the picture the gallery shows when it is off.
 */
async function setManualPicture(photoId: number | null): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    if (photoId === null) {
      await api.removeManualPicture(selected.value.id);
      manualPhotoId.value = null;
    } else {
      await api.setManualPicture(selected.value.id, photoId);
      manualPhotoId.value = photoId;
    }
    notice.value = "The picture was set. The frame picks it up at its next check-in.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Change how the pictures from a chat arrive.
 */
async function setTelegramMode(mode: "queue" | "latest"): Promise<void> {
  telegramMode.value = mode;
  await saveGallery({ telegram_mode: mode });
}

/**
 * Create a gallery.
 *
 * The schedule is made with the gallery, so that a gallery is made the
 * way it is going to be used rather than being left half set up.
 */
async function createGallery(): Promise<void> {
  if (!newName.value.trim()) return;
  error.value = null;
  try {
    await api.createGallery({
      name: newName.value.trim(),
      schedule_enabled: newEnabled.value,
      rules: newRules.value.map((draft) => ({
        days: draft.days,
        start_minute: draft.startMinute,
        end_minute: draft.endMinute,
        min_interval: draft.intervalSeconds,
        max_interval: draft.intervalSeconds,
        rotation_mode: draft.rotationMode,
      })),
    });

    newName.value = "";
    newRules.value = [];
    await session.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Delete a gallery.
 */
async function deleteGallery(target: Gallery): Promise<void> {
  if (!confirm(`Delete "${target.name}" and all of its photos?`)) return;
  error.value = null;
  try {
    await api.deleteGallery(target.id);
    if (selected.value?.id === target.id) {
      selected.value = null;
      photos.value = [];
    }
    await session.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Upload files into the selected gallery.
 */
async function uploadFiles(files: FileList | null): Promise<void> {
  if (!files || !selected.value) return;

  busy.value = true;
  error.value = null;
  notice.value = null;

  try {
    for (const file of Array.from(files)) {
      const data = await file.arrayBuffer();
      const result = await api.uploadPhoto(selected.value.id, file.name, data);
      notice.value = `Rendered ${result.filename} (${Math.round(result.byte_size / 1024)} kB)`;
    }
    photos.value = await api.photos(selected.value.id);
    await session.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Handle a drop onto the upload area.
 */
function onDrop(event: DragEvent): void {
  dragging.value = false;
  void uploadFiles(event.dataTransfer?.files ?? null);
}

async function removePhoto(photo: Photo): Promise<void> {
  if (!confirm(`Delete "${photo.filename}"?`)) return;
  try {
    await api.deletePhoto(photo.id);
    if (selected.value) {
      photos.value = await api.photos(selected.value.id);
    }
    await session.reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Handle a preview that cannot be loaded.
 *
 * The original is only kept from the moment the photo was uploaded, so a
 * photo that was added before that has no preview. The frame is not
 * affected: it uses the rendered asset.
 */
function onPreviewError(event: Event, photo: Photo): void {
  const image = event.target as HTMLImageElement;
  image.style.visibility = "hidden";
  missingPreviews.value.add(photo.id);
}

onMounted(async () => {
  await session.reload();
});
</script>

<template>
  <h1>Galleries</h1>
  <p class="subtitle">
    A gallery is a set of photos and the policy that decides when they are shown.
  </p>

  <div v-if="session.error" class="error">{{ session.error }}</div>
  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="notice" class="ok">{{ notice }}</div>

  <div class="grid-2">
    <!-- Gallery list -->
    <div>
      <h2>Your galleries</h2>

      <div v-if="session.loading" class="empty">Loading...</div>
      <div v-else-if="session.galleries.length === 0" class="empty">
        No galleries yet. Create one to get started.
      </div>

      <div v-for="item in session.galleries" :key="item.id" class="card">
        <div class="row between">
          <div class="grow">
            <strong>{{ item.name }}</strong>
            <div class="small muted">
              {{ item.photo_count }} photo{{ item.photo_count === 1 ? "" : "s" }}
              <template v-if="!item.schedule_enabled">
                · off, showing one picture
              </template>
              <template v-else>
                · {{ item.rule_count }} rule{{ item.rule_count === 1 ? "" : "s" }}
              </template>
            </div>
          </div>
          <button
            class="secondary"
            :class="{ 'is-selected': selected?.id === item.id }"
            @click="selectGallery(item)"
          >
            {{ selected?.id === item.id ? "Selected" : "Open" }}
          </button>
          <button class="danger" @click="deleteGallery(item)">Delete</button>
        </div>
      </div>

      <!-- Create -->
      <div class="card">
        <h2>New gallery</h2>
        <div class="field">
          <label for="gallery-name">Name</label>
          <input id="gallery-name" v-model="newName" placeholder="Living room" />
        </div>

        <!-- The same schedule editor an existing gallery has, so that the
             two do not drift apart. -->
        <h3>Schedule</h3>
        <GallerySchedule
          :enabled="newEnabled"
          :rules="newRules"
          @update:enabled="newEnabled = $event"
          @update:rules="newRules = $event"
        />

        <button @click="createGallery">Create gallery</button>
      </div>
    </div>

    <!-- Photos -->
    <div>
      <template v-if="gallery">
        <h2>Photos in {{ gallery.name }}</h2>

        <div
          class="dropzone"
          :class="{ over: dragging }"
          @click="fileInput?.click()"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onDrop"
        >
          <input
            ref="fileInput"
            type="file"
            accept="image/*"
            multiple
            style="display: none"
            @change="uploadFiles(($event.target as HTMLInputElement).files)"
          />
          <div v-if="busy">Rendering... this takes a moment.</div>
          <div v-else>Drop photos here, or click to choose.</div>
          <div class="small" style="margin-top: 6px">
            Photos are converted to the panel's colours when they are uploaded.
          </div>
        </div>

        <div v-if="photos.length === 0" class="empty">No photos yet.</div>

        <div v-for="photo in photos" :key="photo.id" class="card photo-card">
          <div class="photo-preview">
            <img
              :src="api.photoPreviewUrl(photo.id)"
              :alt="photo.filename"
              loading="lazy"
              @error="onPreviewError($event, photo)"
            />
            <span v-if="missingPreviews.has(photo.id)" class="photo-preview-missing">
              no preview
            </span>
          </div>
          <div class="grow">
            <div>{{ photo.filename }}</div>
            <div class="small muted mono">
              <template v-if="photo.content_hash">
                {{ photo.content_hash.slice(0, 16) }}…
                <template v-if="photo.byte_size">
                  · {{ Math.round(photo.byte_size / 1024) }} kB
                </template>
              </template>
              <template v-else>not rendered</template>
            </div>
          </div>
          <button
            class="secondary"
            :disabled="busy"
            :title="manualPhotoId === photo.id ? 'This is the picture it shows' : 'Show this one'"
            @click="setManualPicture(photo.id)"
          >
            {{ manualPhotoId === photo.id ? "Showing" : "Show this one" }}
          </button>
          <button class="danger" @click="removePhoto(photo)">Delete</button>
        </div>

        <!-- Settings -->
        <div class="card">
          <h3>How the pictures are prepared</h3>
          <p class="small muted">
            The panel has six colours. Every picture is prepared for it
            first, and this is how. Changing it re-renders the pictures.
          </p>

          <div class="field">
            <label for="gallery-tone">Way of preparing</label>
            <select
              id="gallery-tone"
              :value="selected?.tone_preset"
              @change="saveGallery({ tone_preset: ($event.target as HTMLSelectElement).value })"
            >
              <option v-for="preset in TONE_PRESETS" :key="preset.value" :value="preset.value">
                {{ preset.title }}
              </option>
            </select>
            <div class="small muted">
              {{
                TONE_PRESETS.find((p) => p.value === selected?.tone_preset)?.description
              }}
            </div>
          </div>
        </div>

        <div class="card">
          <h3>When the picture changes</h3>
          <p class="small muted">
            The gallery changes the picture at its own pace. A rule says
            which days it applies to and how often the picture changes
            during them, so it can change often by day and slowly
            overnight.
          </p>

          <GallerySchedule
            :enabled="scheduleEnabled"
            :rules="draftRules"
            @update:enabled="setScheduleEnabled"
            @update:rules="onRulesChanged"
          />
        </div>

        <!-- The picture shown while the gallery is off -->
        <div class="card">
          <h3>The picture it shows</h3>
          <p class="small muted">
            <template v-if="scheduleEnabled">
              The gallery changes on its own schedule, but you can say which
              picture it shows at any time by choosing one below. It stays
              until you choose another.
            </template>
            <template v-else>
              The gallery is off, so it shows this picture until you set
              another one. The frame keeps it when it is turned off and on
              again.
            </template>
          </p>

          <div v-if="photos.length === 0" class="empty">
            No photos yet. Add one first.
          </div>

          <div v-else class="row" style="flex-wrap: wrap; gap: 8px">
            <button
              v-for="photo in photos"
              :key="photo.id"
              class="secondary"
              :class="{ 'is-selected': manualPhotoId === photo.id }"
              @click="setManualPicture(photo.id)"
            >
              {{ photo.filename }}
            </button>
          </div>

          <button
            v-if="manualPhotoId !== null"
            class="secondary"
            style="margin-top: 8px"
            @click="setManualPicture(null)"
          >
            Show nothing
          </button>
        </div>

        <!-- How the pictures from a chat arrive -->
        <div class="card">
          <h3>Pictures from a chat</h3>
          <p class="small muted">
            When a picture is sent to this gallery's bot, it either joins
            the end of the queue or replaces the picture that is waiting.
          </p>

          <div class="field">
            <label for="gallery-telegram">How they arrive</label>
            <select
              id="gallery-telegram"
              :value="telegramMode"
              @change="setTelegramMode(($event.target as HTMLSelectElement).value as 'queue' | 'latest')"
            >
              <option value="queue">In the order they were sent</option>
              <option value="latest">The latest one replaces the last</option>
            </select>
            <div class="small muted">
              <template v-if="telegramMode === 'queue'">
                Every picture is shown, one after another. This is what a
                gallery that changes often wants.
              </template>
              <template v-else>
                Only the last picture sent is shown. This is what a
                gallery that changes once a day wants: the ones before it
                would only be shown long after they had been sent.
              </template>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="empty">Select a gallery to see its photos.</div>
    </div>
  </div>
</template>

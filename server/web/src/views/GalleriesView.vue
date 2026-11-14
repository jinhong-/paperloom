<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type Gallery, type GalleryScheduleRule, type Photo, TONE_PRESETS } from "@/api";
import { describeInterval } from "@/lib/syncRules";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();

const selected = ref<Gallery | null>(null);
const photos = ref<Photo[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

/* The rules that say when this gallery changes its picture. */
const rules = ref<GalleryScheduleRule[]>([]);

/* The rule being written. */
const ruleStart = ref("22:00");
const ruleEnd = ref("07:00");
const ruleMin = ref(3600);
const ruleMax = ref(3600);
const ruleSilent = ref(false);

const newName = ref("");
const newMode = ref<"random" | "sequential">("random");
const newMin = ref(900);
const newMax = ref(21600);

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
  try {
    photos.value = await api.photos(target.id);
    rules.value = (await api.galleryScheduleRules(target.id)).rules;
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
 * Add a rule saying when the gallery changes.
 */
async function addRule(): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.addGalleryScheduleRule(selected.value.id, {
      start_minute: toMinutes(ruleStart.value),
      end_minute: toMinutes(ruleEnd.value),
      min_interval: ruleSilent.value ? null : ruleMin.value,
      max_interval: ruleSilent.value ? null : ruleMax.value,
    });
    rules.value = (await api.galleryScheduleRules(selected.value.id)).rules;
    notice.value = "The rule has been added.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Remove a rule.
 */
async function removeRule(rule: GalleryScheduleRule): Promise<void> {
  if (!selected.value) return;
  busy.value = true;
  error.value = null;
  try {
    await api.removeGalleryScheduleRule(selected.value.id, rule.id);
    rules.value = (await api.galleryScheduleRules(selected.value.id)).rules;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Turn a clock time into minutes from midnight.
 */
function toMinutes(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Turn minutes from midnight into a clock time.
 */
function toClock(minute: number): string {
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/**
 * Create a gallery.
 */
async function createGallery(): Promise<void> {
  if (!newName.value.trim()) return;
  error.value = null;
  try {
    await api.createGallery({
      name: newName.value.trim(),
      rotation_mode: newMode.value,
      min_interval: newMin.value,
      max_interval: newMax.value,
    });
    newName.value = "";
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
              {{ item.photo_count }} photo{{ item.photo_count === 1 ? "" : "s" }} ·
              {{ item.rotation_mode }}
              <template v-if="item.rotation_mode === 'random'">
                · every {{ describeInterval(item.min_interval) }}–{{
                  describeInterval(item.max_interval)
                }}
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
        <div class="grid-2">
          <div class="field">
            <label for="gallery-mode">Rotation</label>
            <select id="gallery-mode" v-model="newMode">
              <option value="random">Random</option>
              <option value="sequential">Sequential</option>
            </select>
          </div>
          <div class="field">
            <label for="gallery-min">Minimum gap (seconds)</label>
            <input id="gallery-min" v-model.number="newMin" type="number" min="60" />
            <div class="small muted">That is every {{ describeInterval(newMin) }}.</div>
          </div>
        </div>
        <div class="field">
          <label for="gallery-max">Maximum gap (seconds)</label>
          <input id="gallery-max" v-model.number="newMax" type="number" min="60" />
          <div class="small muted">That is every {{ describeInterval(newMax) }}.</div>
        </div>
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
            how often that is during certain hours, so it can change often
            by day and slowly overnight.
          </p>

          <div v-if="rules.length === 0" class="empty">
            No rules. The gallery changes at the pace set above, all day.
          </div>

          <div
            v-for="rule in rules"
            :key="rule.id"
            class="row between"
            style="padding: 8px 0; border-bottom: 1px solid var(--line)"
          >
            <div class="grow">
              <strong>{{ toClock(rule.start_minute) }} – {{ toClock(rule.end_minute) }}</strong>
              <div class="small muted">
                <template v-if="rule.min_interval === null && rule.max_interval === null">
                  nothing is shown
                </template>
                <template v-else>
                  every {{ describeInterval(rule.min_interval ?? 0) }}–{{
                    describeInterval(rule.max_interval ?? 0)
                  }}
                </template>
              </div>
            </div>
            <button class="danger" :disabled="busy" @click="removeRule(rule)">Remove</button>
          </div>

          <div class="field" style="margin-top: 12px">
            <label>Add a rule</label>
            <div class="row">
              <div class="field grow">
                <label for="rule-start">From</label>
                <input id="rule-start" v-model="ruleStart" placeholder="22:00" />
              </div>
              <div class="field grow">
                <label for="rule-end">Until</label>
                <input id="rule-end" v-model="ruleEnd" placeholder="07:00" />
              </div>
            </div>

            <label class="small" style="display: flex; gap: 8px; align-items: center">
              <input v-model="ruleSilent" type="checkbox" />
              Nothing is shown during these hours
            </label>

            <div v-if="!ruleSilent" class="row">
              <div class="field grow">
                <label for="rule-min">Minimum gap (seconds)</label>
                <input id="rule-min" v-model.number="ruleMin" type="number" min="60" />
              </div>
              <div class="field grow">
                <label for="rule-max">Maximum gap (seconds)</label>
                <input id="rule-max" v-model.number="ruleMax" type="number" min="60" />
              </div>
            </div>

            <button :disabled="busy" @click="addRule">Add rule</button>
          </div>
        </div>
      </template>

      <div v-else class="empty">Select a gallery to see its photos.</div>
    </div>
  </div>
</template>

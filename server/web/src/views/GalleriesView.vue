<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type Gallery, type Photo } from "@/api";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();

const selected = ref<Gallery | null>(null);
const photos = ref<Photo[]>([]);
const busy = ref(false);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);

const newName = ref("");
const newMode = ref<"random" | "sequential">("random");
const newMin = ref(900);
const newMax = ref(21600);

const dragging = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const gallery = computed(() => selected.value);

/**
 * Load the photos of the selected gallery.
 */
async function selectGallery(target: Gallery): Promise<void> {
  selected.value = target;
  photos.value = [];
  error.value = null;
  try {
    photos.value = await api.photos(target.id);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
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
              <template v-if="item.rotation_mode === "random">
                · every {{ formatInterval(item.min_interval) }}–{{
                  formatInterval(item.max_interval)
                }}
              </template>
            </div>
          </div>
          <button
            class="secondary"
            @click="selectGallery(item)"
            :style="selected?.id === item.id ? 'border-color: var(--accent-dim)' : ''"
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
          </div>
        </div>
        <div class="field">
          <label for="gallery-max">Maximum gap (seconds)</label>
          <input id="gallery-max" v-model.number="newMax" type="number" min="60" />
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

        <div v-for="photo in photos" :key="photo.id" class="card row between">
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
      </template>

      <div v-else class="empty">Select a gallery to see its photos.</div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from "vue";

export default defineComponent({
  methods: {
    /**
     * Render a number of seconds as a human-readable interval.
     */
    formatInterval(seconds: number): string {
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
      if (seconds < 86400) return `${(seconds / 3600).toFixed(seconds % 3600 === 0 ? 0 : 1)}h`;
      return `${(seconds / 86400).toFixed(1)}d`;
    },
  },
});
</script>

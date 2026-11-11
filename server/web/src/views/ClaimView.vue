<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { api } from "@/api";

const route = useRoute();
const router = useRouter();

const deviceName = ref<string | null>(null);
const deviceId = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const done = ref(false);

const code = String(route.params.code ?? "");

/**
 * Look up the claim code and show which frame it belongs to.
 */
onMounted(async () => {
  try {
    const info = await api.claimInfo(code);
    deviceName.value = info.name;
    deviceId.value = info.device_id;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

/**
 * Claim the frame.
 */
async function claim(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await api.claim(code);
    done.value = true;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div style="max-width: 460px; margin: 60px auto">
    <h1>Claim a frame</h1>
    <p class="subtitle">
      The code came from the screen of the frame you want to add.
    </p>

    <div v-if="error" class="error">{{ error }}</div>

    <div v-if="done" class="ok">
      The frame is yours. It will pick up its schedule at the next check-in.
      <div style="margin-top: 12px">
        <button @click="router.push('/devices')">Go to your frames</button>
      </div>
    </div>

    <div v-else class="card">
      <template v-if="deviceName">
        <table style="margin-bottom: 16px">
          <tbody>
            <tr>
              <td class="muted">Frame</td>
              <td><strong>{{ deviceName }}</strong></td>
            </tr>
            <tr>
              <td class="muted">Device id</td>
              <td class="mono">{{ deviceId }}</td>
            </tr>
          </tbody>
        </table>

        <button :disabled="busy" style="width: 100%" @click="claim">
          {{ busy ? "Claiming..." : `Claim ${deviceName}` }}
        </button>
      </template>

      <div v-else-if="!error" class="empty">Looking up the code...</div>
    </div>
  </div>
</template>

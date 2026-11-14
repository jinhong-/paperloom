<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

/**
 * Whether the server still has no owner.
 *
 * If it has, there is a setup page waiting, and it is offered here
 * rather than being left for the person to find on their own.
 */
const setupOpen = ref(false);

onMounted(async () => {
  await session.refreshSetup();
  setupOpen.value = session.setupOpen === true;
});

async function submit(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await session.login(username.value, password.value);

    /* Go back to wherever they were going before they were asked to sign
     * in. */
    const next = route.query.next;
    await router.push(typeof next === "string" && next.length > 0 ? next : "/galleries");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div style="max-width: 380px; margin: 60px auto">
    <h1>Sign in</h1>
    <p class="subtitle">Paperloom management</p>

    <form class="card" @submit.prevent="submit">
      <div v-if="error" class="error">{{ error }}</div>

      <div class="field">
        <label for="username">Username</label>
        <input id="username" v-model="username" autocomplete="username" required />
      </div>

      <div class="field">
        <label for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="current-password"
          required
        />
      </div>

      <button type="submit" :disabled="busy" style="width: 100%">
        {{ busy ? "Signing in..." : "Sign in" }}
      </button>
    </form>

    <div v-if="setupOpen" class="card">
      <h3>This server has no owner yet</h3>
      <p class="small muted">
        Set up the first account to take it on. Everybody else is invited
        by the owner afterwards.
      </p>
      <RouterLink to="/setup" class="button">Set up this server</RouterLink>
    </div>
  </div>
</template>

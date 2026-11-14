<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { api } from "@/api";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

/**
 * Whether the first account can still be made.
 *
 * Only the first account may be made this way. Anybody else is invited
 * by the owner, so the link to the registration page is only offered
 * while it is still possible.
 */
const registrationOpen = ref(false);

onMounted(async () => {
  try {
    registrationOpen.value = (await api.registrationOpen()).open;
  } catch {
    /* If the server cannot be asked, the link is not offered. */
  }
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

    <p v-if="registrationOpen" class="small muted">
      No account yet? <RouterLink to="/register">Create one</RouterLink>
    </p>
  </div>
</template>

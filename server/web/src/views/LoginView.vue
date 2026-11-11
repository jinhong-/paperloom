<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const router = useRouter();

const username = ref("");
const password = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

async function submit(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await session.login(username.value, password.value);
    await router.push("/galleries");
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

    <p class="small muted">
      No account yet? <RouterLink to="/register">Create one</RouterLink>
    </p>
  </div>
</template>

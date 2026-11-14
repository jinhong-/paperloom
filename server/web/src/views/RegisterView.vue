<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const router = useRouter();

const username = ref("");
const password = ref("");
const confirm = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

async function submit(): Promise<void> {
  error.value = null;
  if (password.value !== confirm.value) {
    error.value = "The passwords do not match";
    return;
  }
  busy.value = true;
  try {
    await session.register(username.value, password.value);
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
    <h1>Create an account</h1>
    <p class="subtitle">
      This account will own the frames. Anybody else who needs access is
      invited from the People page once you are signed in.
    </p>

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
          autocomplete="new-password"
          minlength="8"
          required
        />
      </div>

      <div class="field">
        <label for="confirm">Confirm password</label>
        <input
          id="confirm"
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          required
        />
      </div>

      <button type="submit" :disabled="busy" style="width: 100%">
        {{ busy ? "Creating..." : "Create account" }}
      </button>
    </form>

    <p class="small muted">
      Already have an account? <RouterLink to="/login">Sign in</RouterLink>
    </p>
  </div>
</template>

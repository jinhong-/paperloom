<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { api } from "@/api";
import { useSessionStore } from "@/stores/session";

const route = useRoute();
const router = useRouter();
const session = useSessionStore();

const code = String(route.params.code ?? "");

/** The name of the person who was invited. */
const invitedName = ref<string | null>(null);
/** Who invited them. */
const invitedBy = ref<string | null>(null);

const password = ref("");
const confirm = ref("");
const error = ref<string | null>(null);
const busy = ref(false);
const done = ref(false);

onMounted(async () => {
  try {
    const info = await api.invitationInfo(code);
    invitedName.value = info.username;
    invitedBy.value = info.invited_by;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});

async function submit(): Promise<void> {
  error.value = null;
  if (password.value !== confirm.value) {
    error.value = "The passwords do not match";
    return;
  }
  busy.value = true;
  try {
    await api.acceptInvitation(code, password.value);
    done.value = true;
    /* Sign them in straight away, so that they do not have to type it
     * all again. */
    await session.login(invitedName.value ?? "", password.value);
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
    <h1>Join this server</h1>
    <p class="subtitle">
      <template v-if="invitedBy">
        {{ invitedBy }} has invited you to use this server.
      </template>
      <template v-else>You have been invited to use this server.</template>
    </p>

    <form class="card" @submit.prevent="submit">
      <div v-if="error" class="error">{{ error }}</div>

      <div class="field">
        <label>Your name</label>
        <div class="static-value">{{ invitedName ?? "..." }}</div>
      </div>

      <div class="field">
        <label for="password">Choose a password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          autocomplete="new-password"
          minlength="8"
          required
        />
        <div class="small muted">At least 8 characters.</div>
      </div>

      <div class="field">
        <label for="confirm">Confirm password</label>
        <input
          id="confirm"
          v-model="confirm"
          type="password"
          autocomplete="new-password"
          minlength="8"
          required
        />
      </div>

      <button type="submit" :disabled="busy || done" style="width: 100%">
        {{ busy ? "Joining..." : "Join" }}
      </button>
    </form>
  </div>
</template>

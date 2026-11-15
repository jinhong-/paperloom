<script setup lang="ts">
/**
 * The setup page.
 *
 * This is where the first account is made. The server has no owner until
 * somebody comes here, and only the first account may be made this way:
 * everybody else is invited by the owner.
 */

import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const route = useRoute();
const router = useRouter();

/** The step the setup is on. */
const step = ref<1 | 2>(1);

const username = ref("");
const password = ref("");
const confirm = ref("");
const error = ref<string | null>(null);
const busy = ref(false);

/**
 * Whether the server still has no owner.
 *
 * Until this is known, the page waits rather than offering a form that
 * the server might refuse.
 */
const ready = ref(false);

/**
 * Whether the server already has an owner.
 *
 * That means somebody else got here first, and this page has nothing to
 * offer any more.
 */
const taken = ref(false);

onMounted(async () => {
  await session.refreshSetup();
  ready.value = true;
  taken.value = session.setupOpen === false;
});

/**
 * The password rules, so that they are shown before the form is sent.
 */
const passwordProblems = computed(() => {
  const problems: string[] = [];
  if (password.value.length > 0 && password.value.length < 8) {
    problems.push("The password must be at least 8 characters.");
  }
  if (confirm.value.length > 0 && password.value !== confirm.value) {
    problems.push("The passwords do not match.");
  }
  return problems;
});

const canContinue = computed(() => {
  if (username.value.trim().length === 0) return false;
  if (password.value.length < 8) return false;
  if (password.value !== confirm.value) return false;
  return true;
});

/**
 * Go to the next step.
 */
function next(): void {
  error.value = null;
  if (!canContinue.value) {
    error.value = "Fill in the name and the two passwords before continuing.";
    return;
  }
  step.value = 2;
}

/**
 * Go back to the previous step.
 */
function back(): void {
  error.value = null;
  step.value = 1;
}

/**
 * Make the owner account.
 */
async function submit(): Promise<void> {
  error.value = null;
  busy.value = true;
  try {
    await session.becomeOwner(username.value.trim(), password.value);

    /* The server has an owner now, so the setup page is not the way in
     * any more. */
    session.setupOpen = false;

    const next = route.query.next;
    await router.push(
      typeof next === "string" && next.length > 0 ? next : "/galleries",
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div style="max-width: 420px; margin: 60px auto">
    <h1>Set up Paperloom</h1>
    <p class="subtitle">
      This server has no owner yet. Make the first account to take it on.
    </p>

    <div v-if="!ready" class="empty">Checking...</div>

    <div v-else-if="taken" class="card">
      <p>
        This server already has an owner, so there is nothing to set up.
      </p>
      <RouterLink to="/login" class="button">Sign in</RouterLink>
    </div>

    <template v-else>
      <!-- The steps -->
      <div class="row small muted" style="margin-bottom: 16px">
        <span :style="{ color: step === 1 ? 'var(--text)' : undefined }">
          1. The owner
        </span>
        <span>·</span>
        <span :style="{ color: step === 2 ? 'var(--text)' : undefined }">
          2. Confirm
        </span>
      </div>

      <div v-if="error" class="error">{{ error }}</div>

      <form v-if="step === 1" class="card" @submit.prevent="next">
        <div class="field">
          <label for="setup-username">Your name</label>
          <input
            id="setup-username"
            v-model="username"
            autocomplete="username"
            required
            autofocus
          />
          <div class="small muted">
            This is the owner. It holds the frames and the photos, and it is
            the account that invites other people.
          </div>
        </div>

        <div class="field">
          <label for="setup-password">Password</label>
          <input
            id="setup-password"
            v-model="password"
            type="password"
            autocomplete="new-password"
            minlength="8"
            required
          />
          <div class="small muted">At least 8 characters.</div>
        </div>

        <div class="field">
          <label for="setup-confirm">Confirm password</label>
          <input
            id="setup-confirm"
            v-model="confirm"
            type="password"
            autocomplete="new-password"
            required
          />
        </div>

        <button type="submit" style="width: 100%">Continue</button>
      </form>

      <form v-else class="card" @submit.prevent="submit">
        <div class="field">
          <label>Owner</label>
          <div class="static-value">{{ username }}</div>
        </div>

        <div class="field">
          <label>Password</label>
          <div class="static-value">
            {{ "•".repeat(Math.min(password.length, 32)) }}
          </div>
        </div>

        <div v-if="passwordProblems.length" class="field">
          <div v-for="problem in passwordProblems" :key="problem" class="small muted">
            {{ problem }}
          </div>
        </div>

        <p class="small muted">
          This account owns the frames. Anybody else who needs access is
          invited from the People page once you are signed in.
        </p>

        <div class="row">
          <button type="button" class="secondary" @click="back">Back</button>
          <button type="submit" :disabled="busy" class="grow">
            {{ busy ? "Setting up..." : "Create the account" }}
          </button>
        </div>
      </form>

      <p class="small muted">
        Already have an account? <RouterLink to="/login">Sign in</RouterLink>
      </p>
    </template>
  </div>
</template>

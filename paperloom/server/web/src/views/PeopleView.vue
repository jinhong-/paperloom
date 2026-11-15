<script setup lang="ts">
import { onMounted, ref } from "vue";

import { api, type Invitation, type User } from "@/api";

const users = ref<User[]>([]);
const invitations = ref<Invitation[]>([]);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

/** The name being invited. */
const newName = ref("");

/**
 * The invitation that has just been made, so that its code can be given
 * to the person. The code is only shown once.
 */
const freshCode = ref<string | null>(null);

async function load(): Promise<void> {
  error.value = null;
  try {
    const result = await api.users();
    users.value = result.users;
    invitations.value = result.invitations;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

onMounted(load);

async function invite(): Promise<void> {
  error.value = null;
  notice.value = null;
  freshCode.value = null;

  const name = newName.value.trim();
  if (!name) {
    error.value = "A name is needed";
    return;
  }

  busy.value = true;
  try {
    const invitation = await api.inviteUser(name);
    freshCode.value = invitation.invite_code;
    notice.value = `${invitation.username} has been invited`;
    newName.value = "";
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * The address the invitation is followed at.
 */
function invitationUrl(code: string): string {
  return `${window.location.origin}/invitation/${code}`;
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    notice.value = "The address has been copied";
  } catch {
    notice.value = text;
  }
}
</script>

<template>
  <h1>People</h1>
  <p class="subtitle">
    The first account owns the frames. Anybody else has to be invited, so that
    nobody can simply make themselves an account and start looking at your
    photos.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="notice" class="ok">{{ notice }}</div>

  <div class="grid-2">
    <div>
      <h2>Invite somebody</h2>

      <div class="card">
        <div class="field">
          <label for="invite-name">Their name</label>
          <input id="invite-name" v-model="newName" autocomplete="off" />
          <div class="small muted">They choose their own password when they join.</div>
        </div>
        <button @click="invite" :disabled="busy">
          {{ busy ? "Inviting..." : "Invite" }}
        </button>
      </div>

      <div v-if="freshCode" class="card">
        <h3>Give them this address</h3>
        <p class="small muted">It is shown once. They choose their password when they follow it.</p>
        <div class="static-value">{{ invitationUrl(freshCode) }}</div>
        <button class="secondary" @click="copy(invitationUrl(freshCode))">Copy</button>
      </div>
    </div>

    <div>
      <h2>Who has access</h2>

      <div class="card">
        <div v-for="user in users" :key="user.id" class="row between">
          <span>{{ user.username }}</span>
          <span class="muted small">{{ user.id === 1 ? "owner" : "invited" }}</span>
        </div>
        <div v-if="users.length === 0" class="empty">Nobody yet.</div>
      </div>

      <h2>Waiting to join</h2>

      <div class="card">
        <div v-for="invitation in invitations" :key="invitation.id" class="row between">
          <span>{{ invitation.username }}</span>
          <span class="muted small">{{ invitation.accepted_at ? "joined" : "invited" }}</span>
        </div>
        <div v-if="invitations.length === 0" class="empty">Nobody is waiting.</div>
      </div>
    </div>
  </div>
</template>

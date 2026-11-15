<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const router = useRouter();

/* Whether the first page is still being worked out.
 *
 * The page is told where to send the owner before it shows anything, and
 * that takes a journey to and fro. Without something in its place the
 * page would be blank until then, which looks like a fault. */
const settling = computed(() => router.currentRoute.value.name === undefined);
</script>

<template>
  <div class="shell">
    <header class="top">
      <RouterLink to="/" class="brand">Paper<span>loom</span></RouterLink>
      <nav v-if="session.signedIn()">
        <RouterLink to="/galleries">Galleries</RouterLink>
        <RouterLink to="/devices">Devices</RouterLink>
        <RouterLink to="/telegram">Telegram</RouterLink>
        <RouterLink to="/people">People</RouterLink>
      </nav>
      <div class="who">
        <template v-if="session.signedIn()">
          <span>{{ session.username }}</span>
          <button class="link" @click="session.logout()">Sign out</button>
        </template>
        <RouterLink v-else to="/login">Sign in</RouterLink>
      </div>
    </header>

    <RouterView v-if="!settling" />
    <div v-else class="empty">Loading...</div>
  </div>
</template>

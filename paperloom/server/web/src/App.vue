<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const router = useRouter();

/* Whether the first page is still being worked out.
 *
 * The page is told where to send the owner before it shows anything, and
 * that takes a journey to and fro. Without something in its place the
 * page would be blank until then, which looks like a fault.
 *
 * The router says when it has finished its first journey, and that is
 * what is waited for. The name of the current route is not a reliable
 * sign: a route without a name is still a route, and the page would sit
 * saying it was loading for ever. */
const ready = ref(false);

onMounted(async () => {
  await router.isReady();
  ready.value = true;
});

const settling = computed(() => !ready.value);
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

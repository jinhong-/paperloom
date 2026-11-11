<script setup lang="ts">
import { onMounted } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
const route = useRoute();

onMounted(async () => {
  await session.refresh();
});
</script>

<template>
  <div class="shell">
    <header v-if="!route.meta.public" class="top">
      <RouterLink to="/galleries" class="brand">Paper<span>loom</span></RouterLink>
      <nav v-if="session.signedIn()">
        <RouterLink to="/galleries">Galleries</RouterLink>
        <RouterLink to="/devices">Devices</RouterLink>
      </nav>
      <div class="who">
        <template v-if="session.signedIn()">
          <span>{{ session.username }}</span>
          <button class="link" @click="session.logout()">Sign out</button>
        </template>
        <RouterLink v-else to="/login">Sign in</RouterLink>
      </div>
    </header>

    <RouterView />
  </div>
</template>

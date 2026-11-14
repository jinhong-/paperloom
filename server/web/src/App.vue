<script setup lang="ts">
import { RouterLink, RouterView } from "vue-router";

import { useSessionStore } from "@/stores/session";

const session = useSessionStore();
</script>

<template>
  <div class="shell">
    <header class="top">
      <RouterLink to="/galleries" class="brand">Paper<span>loom</span></RouterLink>
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

    <RouterView />
  </div>
</template>

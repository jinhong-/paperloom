<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type PhotoJob, type TelegramBot, type TelegramChat } from "@/api";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();

const bots = ref<TelegramBot[]>([]);
const chats = ref<TelegramChat[]>([]);
const jobs = ref<PhotoJob[]>([]);
const pending = ref(0);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const selectedBot = ref<TelegramBot | null>(null);

/** The token for a gallery that is being set up. */
const token = ref("");
/** The gallery a new bot is being made for. */
const newGalleryId = ref<number | null>(null);

/** The chat being added to the selected bot. */
const newChatId = ref("");
const newChatLabel = ref("");

/** The galleries that do not have a bot yet. */
const galleriesWithoutBot = computed(() =>
  session.galleries.filter((g) => !bots.value.some((b) => b.gallery_id === g.id)),
);

onMounted(async () => {
  await session.reload();
  await reload();
});

async function reload(): Promise<void> {
  error.value = null;
  try {
    const [list, queue] = await Promise.all([api.telegramBots(), api.telegramQueue()]);
    bots.value = list.bots;
    jobs.value = queue.jobs;
    pending.value = queue.pending;

    /* Keep the selection, if the bot it points at is still there. */
    if (selectedBot.value) {
      const found = bots.value.find((b) => b.id === selectedBot.value?.id);
      selectedBot.value = found ?? null;
      if (!found) chats.value = [];
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Give a gallery its own bot.
 */
async function addBot(): Promise<void> {
  if (!newGalleryId.value || !token.value.trim()) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    const result = await api.setTelegramBot(newGalleryId.value, token.value.trim());
    token.value = "";
    newGalleryId.value = null;
    await reload();
    notice.value = result.username
      ? `The bot @${result.username} is now running.`
      : "The bot is now running.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Take a gallery's bot away.
 */
async function removeBot(bot: TelegramBot): Promise<void> {
  if (!confirm(`Stop the bot for "${bot.gallery_name}"?`)) return;
  error.value = null;
  try {
    await api.removeTelegramBot(bot.gallery_id);
    if (selectedBot.value?.id === bot.id) {
      selectedBot.value = null;
      chats.value = [];
    }
    await reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Look at the chats that talk to a bot.
 */
async function selectBot(bot: TelegramBot): Promise<void> {
  error.value = null;
  try {
    chats.value = await api.telegramChats(bot.id);
    selectedBot.value = bot;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Add a chat to a bot.
 */
async function addChat(): Promise<void> {
  if (!selectedBot.value || !newChatId.value.trim()) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.addTelegramChat(selectedBot.value.id, {
      chat_id: newChatId.value.trim(),
      label: newChatLabel.value.trim() || undefined,
    });
    newChatId.value = "";
    newChatLabel.value = "";
    chats.value = await api.telegramChats(selectedBot.value.id);
    await reload();
    notice.value = "The chat is now linked to the bot.";
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Unlink a chat.
 */
async function removeChat(chat: TelegramChat): Promise<void> {
  if (!selectedBot.value) return;
  if (!confirm(`Stop filing pictures from this chat?`)) return;
  error.value = null;
  try {
    await api.removeTelegramChat(selectedBot.value.id, chat.chat_id);
    chats.value = await api.telegramChats(selectedBot.value.id);
    await reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
</script>

<template>
  <h1>Telegram</h1>
  <p class="subtitle">
    Give a gallery its own bot, and send pictures to that bot to fill the gallery.
  </p>

  <div v-if="error" class="error">{{ error }}</div>
  <div v-if="notice" class="ok">{{ notice }}</div>

  <div class="grid-2">
    <!-- Bots -->
    <div>
      <h2>Your bots</h2>

      <div v-if="bots.length === 0" class="empty">
        No bots yet. Give one of your galleries a bot below.
      </div>

      <div v-for="bot in bots" :key="bot.id" class="card">
        <div class="row between">
          <div class="grow">
            <strong>{{ bot.gallery_name }}</strong>
            <div class="small muted">
              <template v-if="bot.username">@{{ bot.username }}</template>
              <template v-else>the bot's name is not known yet</template>
              · {{ bot.chat_count }} chat{{ bot.chat_count === 1 ? "" : "s" }}
              <template v-if="bot.polling">· running</template>
              <template v-else>· not running</template>
            </div>
            <div v-if="bot.error" class="small error">{{ bot.error }}</div>
          </div>
          <button
            class="secondary"
            :class="{ 'is-selected': selectedBot?.id === bot.id }"
            @click="selectBot(bot)"
          >
            {{ selectedBot?.id === bot.id ? "Selected" : "Chats" }}
          </button>
          <button class="danger" @click="removeBot(bot)">Remove</button>
        </div>
      </div>

      <!-- Add a bot -->
      <div class="card">
        <h2>Add a bot</h2>
        <p class="small muted">
          Make a bot with
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>
          and paste its token here. Each gallery needs its own bot, so that a
          picture is always filed into the gallery it was sent to.
        </p>

        <div class="field">
          <label for="telegram-gallery">Gallery</label>
          <select id="telegram-gallery" v-model="newGalleryId">
            <option :value="null">Choose a gallery</option>
            <option v-for="gallery in galleriesWithoutBot" :key="gallery.id" :value="gallery.id">
              {{ gallery.name }}
            </option>
          </select>
          <div v-if="galleriesWithoutBot.length === 0" class="small muted">
            Every gallery already has a bot.
          </div>
        </div>

        <div class="field">
          <label for="telegram-token">Bot token</label>
          <input
            id="telegram-token"
            v-model="token"
            type="password"
            autocomplete="off"
            placeholder="123456789:AA..."
          />
          <div class="small muted">
            The token is checked with Telegram before it is saved.
          </div>
        </div>

        <button :disabled="busy || !newGalleryId || !token.trim()" @click="addBot">
          Save bot
        </button>
      </div>
    </div>

    <!-- Chats and queue -->
    <div>
      <h2>Chats</h2>

      <template v-if="selectedBot">
        <p class="small muted" style="margin-bottom: 8px">
          Chats that may file pictures into {{ selectedBot.gallery_name }}.
          Add a chat by sending it a picture: the bot will say which chat it is.
        </p>

        <div v-if="chats.length === 0" class="empty">No chats linked yet.</div>

        <div v-for="chat in chats" :key="chat.id" class="card">
          <div class="row between">
            <div class="grow">
              <strong>{{ chat.label ?? chat.chat_id }}</strong>
              <div class="small muted mono">{{ chat.chat_id }}</div>
            </div>
            <button class="danger" @click="removeChat(chat)">Unlink</button>
          </div>
        </div>

        <div class="card">
          <h2>Add a chat</h2>
          <div class="field">
            <label for="telegram-chat">Chat id</label>
            <input id="telegram-chat" v-model="newChatId" placeholder="-1001234567890" />
          </div>
          <div class="field">
            <label for="telegram-chat-label">Label</label>
            <input id="telegram-chat-label" v-model="newChatLabel" placeholder="Family chat" />
            <div class="small muted">Optional. A name for the chat, so it is easy to tell apart.</div>
          </div>
          <button :disabled="busy || !newChatId.trim()" @click="addChat">Link chat</button>
        </div>
      </template>

      <div v-else class="empty">Choose a bot to see the chats that talk to it.</div>

      <h2 style="margin-top: 24px">Recent pictures</h2>

      <div class="small muted" style="margin-bottom: 8px">
        {{ pending }} waiting to be rendered.
      </div>

      <div v-if="jobs.length === 0" class="empty">Nothing has arrived yet.</div>

      <div v-for="job in jobs" :key="job.id" class="card">
        <div class="row between">
          <div class="grow">
            <div>{{ job.filename }}</div>
            <div class="small muted">
              {{ job.gallery_name }} · {{ job.status }}
              <template v-if="job.origin"> · {{ job.origin }}</template>
            </div>
            <div v-if="job.error" class="small error">{{ job.error }}</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

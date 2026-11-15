<script setup lang="ts">
import { computed, onMounted, ref } from "vue";

import { api, type PhotoJob, type TelegramBot, type TelegramPersonAccess } from "@/api";
import { useSessionStore } from "@/stores/session";

const session = useSessionStore();

const bots = ref<TelegramBot[]>([]);
const jobs = ref<PhotoJob[]>([]);
const pending = ref(0);
const error = ref<string | null>(null);
const notice = ref<string | null>(null);
const busy = ref(false);

const selectedBot = ref<TelegramBot | null>(null);

/* The people who talk to the selected bot. */
const peoplePending = ref<TelegramPersonAccess[]>([]);
const peopleAllowed = ref<TelegramPersonAccess[]>([]);

/** The token for a gallery that is being set up. */
const token = ref("");
/** The gallery a new bot is being made for. */
const newGalleryId = ref<number | null>(null);

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
      if (!found) {
        peoplePending.value = [];
        peopleAllowed.value = [];
      }
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
      peoplePending.value = [];
      peopleAllowed.value = [];
    }
    await reload();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Look at the people who talk to a bot.
 */
async function selectBot(bot: TelegramBot): Promise<void> {
  error.value = null;
  try {
    const personList = await api.telegramPeople(bot.id);
    peoplePending.value = personList.pending;
    peopleAllowed.value = personList.allowed;
    selectedBot.value = bot;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

/**
 * Let a person send pictures to a bot.
 *
 * The pictures they sent while they were waiting are filed now, so that
 * they are not lost.
 */
async function allowPerson(person: TelegramPersonAccess): Promise<void> {
  if (!selectedBot.value) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    const result = await api.allowTelegramPerson(selectedBot.value.id, person.person.telegramId);
    await selectBot(selectedBot.value);
    notice.value =
      result.filed > 0
        ? `${personName(person)} was allowed, and ${result.filed} picture(s) were filed.`
        : `${personName(person)} was allowed.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * Stop a person sending pictures to a bot.
 */
async function blockPerson(person: TelegramPersonAccess): Promise<void> {
  if (!selectedBot.value) return;
  if (!confirm(`Stop ${personName(person)} from sending pictures to this frame?`)) return;
  busy.value = true;
  error.value = null;
  notice.value = null;
  try {
    await api.blockTelegramPerson(selectedBot.value.id, person.person.telegramId);
    await selectBot(selectedBot.value);
    notice.value = `${personName(person)} was blocked.`;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}

/**
 * The name to show for a person.
 */
function personName(person: TelegramPersonAccess): string {
  const p = person.person;
  if (p.displayName) return p.displayName;
  if (p.username) return `@${p.username}`;
  return `Telegram user ${p.telegramId}`;
}

/**
 * The people who are allowed to send pictures, and the ones waiting.
 */
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
              · {{ bot.allowed_count }} allowed
              <template v-if="bot.pending_count > 0">
                · <strong>{{ bot.pending_count }} waiting</strong>
              </template>
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
            {{ selectedBot?.id === bot.id ? "Selected" : "People" }}
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

    <!-- People and queue -->
    <div>
      <h2>People</h2>

      <template v-if="selectedBot">
        <p class="small muted" style="margin-bottom: 8px">
          The people who may send pictures to {{ selectedBot.gallery_name }}.
          Somebody who is not allowed yet has their picture held until you
          decide about them.
        </p>

        <div v-if="peoplePending.length > 0" class="card">
          <h3>Waiting to be allowed</h3>
          <p class="small muted">
            These people have sent a picture and are waiting for you to allow
            or block them.
          </p>

          <div v-for="person in peoplePending" :key="person.person.id" class="row between" style="padding: 8px 0; border-bottom: 1px solid var(--line)">
            <div class="grow">
              <strong>{{ personName(person) }}</strong>
              <div class="small muted mono">{{ person.person.telegramId }}</div>
              <div v-if="person.heldCount > 0" class="small muted">
                {{ person.heldCount }} picture(s) waiting
                <template v-if="person.heldFilename"> · {{ person.heldFilename }}</template>
              </div>
            </div>
            <div class="row">
              <button :disabled="busy" @click="allowPerson(person)">Allow</button>
              <button class="danger" :disabled="busy" @click="blockPerson(person)">Block</button>
            </div>
          </div>
        </div>

        <h3 style="margin-top: 20px">Allowed</h3>

        <div v-if="peopleAllowed.length === 0" class="empty">
          Nobody has been allowed yet. A picture sent by somebody else is held
          until you allow them.
        </div>

        <div v-for="person in peopleAllowed" :key="person.person.id" class="card">
          <div class="row between">
            <div class="grow">
              <strong>{{ personName(person) }}</strong>
              <div class="small muted mono">{{ person.person.telegramId }}</div>
            </div>
            <button class="danger" :disabled="busy" @click="blockPerson(person)">Block</button>
          </div>
        </div>
      </template>

      <div v-else class="empty">Choose a bot to see the people that talk to it.</div>

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

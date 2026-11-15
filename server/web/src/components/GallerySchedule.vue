<script setup lang="ts">
/**
 * The schedule of a gallery.
 *
 * When the gallery changes its picture, and how often.
 *
 * The same editor is used when a gallery is made and when it is changed,
 * so that the two do not drift apart and the owner is not asked the same
 * question in two different ways.
 *
 * A gallery that is off changes only when the owner sets the picture by
 * hand. The switch is here rather than being worked out from the rules,
 * because a gallery that has just been made has no rules yet, and that
 * is not the same as a gallery that has been turned off.
 */
import { computed, ref, watch } from "vue";

import { DAY_NAMES, DAY_SHORT } from "@/lib/dayNames";
import {
  describeUnit,
  frequencyInSeconds,
  frequencyLimit,
  frequencyWithinLimit,
  type FrequencyUnit,
} from "@/lib/frequency";

/** A rule as the page holds it while it is being written. */
export interface DraftRule {
  id?: number;
  /** A bit mask of the days of the week. */
  days: number;
  /** Minutes from local midnight. */
  startMinute: number;
  /** Minutes from local midnight. */
  endMinute: number;
  /** How often the picture changes, in seconds. Null means the gallery is still. */
  intervalSeconds: number | null;
}

const props = defineProps<{
  /** Whether the gallery changes its picture on its own. */
  enabled: boolean;
  /** The rules that say when it changes. */
  rules: DraftRule[];
}>();

const emit = defineEmits<{
  (event: "update:enabled", value: boolean): void;
  (event: "update:rules", value: DraftRule[]): void;
}>();

/* The rule being written. */
const days = ref<number[]>([1, 2, 3, 4, 5]);
const startMinute = ref(0);
const endMinute = ref(1440);
const count = ref(60);
const unit = ref<FrequencyUnit>("minutes");
const still = ref(false);

/* The hours of the rule being written, as they are typed. */
const startText = ref("00:00");
const endText = ref("24:00");

/* The days as a bit mask. */
const dayMask = computed(() =>
  days.value.reduce((bits, day) => bits | (1 << day), 0),
);

/* How often the picture may change, given the days that were chosen. */
const limitSeconds = computed(() => frequencyLimit(dayMask.value));

/* Whether the frequency that was chosen is within the limit. */
const withinLimit = computed(() => {
  if (still.value) return true;
  return frequencyWithinLimit(count.value, unit.value, dayMask.value);
});

/* The limit, said in the unit the owner chose where possible. */
const limitText = computed(() => {
  if (limitSeconds.value === null) return "";
  const daysLimit = limitSeconds.value / (24 * 60 * 60);
  return `at most every ${daysLimit} ${describeUnit("days", daysLimit)}`;
});

/**
 * Turn a clock time into minutes from midnight.
 *
 * The end of the day is written as 24:00, which is the same moment as
 * the start of the next day but is clearer in a field.
 */
function toMinutes(text: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * Turn minutes from midnight into a clock time.
 */
function toClock(minute: number): string {
  const hours = Math.floor(minute / 60);
  return `${String(hours).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/* The hours of the rule being written follow what is typed. */
watch(startText, (text) => {
  startMinute.value = toMinutes(text);
});
watch(endText, (text) => {
  endMinute.value = toMinutes(text);
});

/**
 * Add a day, or take it away.
 */
function toggleDay(day: number): void {
  const at = days.value.indexOf(day);
  if (at >= 0) {
    days.value = days.value.filter((d) => d !== day);
  } else {
    days.value = [...days.value, day].sort();
  }
}

/**
 * Choose every day, or none.
 */
function chooseAll(): void {
  days.value = days.value.length === 7 ? [] : [0, 1, 2, 3, 4, 5, 6];
}

/**
 * Add the rule being written.
 */
function addRule(): void {
  if (!withinLimit.value) return;

  const rule: DraftRule = {
    days: dayMask.value,
    startMinute: startMinute.value,
    endMinute: endMinute.value,
    intervalSeconds: still.value ? null : frequencyInSeconds(count.value, unit.value),
  };

  emit("update:rules", [...props.rules, rule]);
}

/**
 * Remove a rule.
 */
function removeRule(index: number): void {
  emit(
    "update:rules",
    props.rules.filter((_, at) => at !== index),
  );
}

/**
 * The days a rule names, as they are written.
 */
function describeRuleDays(rule: DraftRule): string {
  const chosen = DAY_NAMES.filter((_, index) => (rule.days & (1 << index)) !== 0);
  if (chosen.length === 0) return "no days";
  if (chosen.length === 7) return "every day";
  return chosen.join(", ");
}

/**
 * How often a rule changes the picture, as it is written.
 */
function describeRuleInterval(rule: DraftRule): string {
  if (rule.intervalSeconds === null) return "nothing is shown";

  const days = rule.intervalSeconds / (24 * 60 * 60);
  if (Number.isInteger(days) && days >= 1) {
    return `every ${days} ${describeUnit("days", days)}`;
  }

  const hours = rule.intervalSeconds / (60 * 60);
  if (Number.isInteger(hours) && hours >= 1) {
    return `every ${hours} ${describeUnit("hours", hours)}`;
  }

  const minutes = Math.round(rule.intervalSeconds / 60);
  return `every ${minutes} ${describeUnit("minutes", minutes)}`;
}

/**
 * The hours a rule covers, as they are written.
 */
function describeRuleHours(rule: DraftRule): string {
  const wholeDay = rule.startMinute === 0 && rule.endMinute === 1440 && rule.days === 127;
  if (wholeDay) return "all day";
  return `${toClock(rule.startMinute)} – ${toClock(rule.endMinute)}`;
}

/* The rule being written starts where the last one left off, so that
 * adding a second rule does not land on top of the first. */
watch(
  () => props.rules.length,
  () => {
    if (props.rules.length === 0) {
      days.value = [1, 2, 3, 4, 5];
      startMinute.value = 0;
      endMinute.value = 1440;
    }
  },
);
</script>

<template>
  <div class="field">
    <label class="check">
      <input
        type="checkbox"
        :checked="enabled"
        @change="emit('update:enabled', ($event.target as HTMLInputElement).checked)"
      />
      The gallery changes its picture on its own
    </label>
    <div class="small muted">
      <template v-if="enabled">
        The rules below say when it changes. With no rules it changes at
        the pace set above, all day.
      </template>
      <template v-else>
        The gallery is off. It shows the picture set below, and changes
        only when you set a new one.
      </template>
    </div>
  </div>

  <template v-if="enabled">
    <div v-if="rules.length === 0" class="empty">
      No rules. The gallery changes at the pace set above, all day.
    </div>

    <div
      v-for="(rule, index) in rules"
      :key="index"
      class="row between"
      style="padding: 8px 0; border-bottom: 1px solid var(--line)"
    >
      <div class="grow">
        <strong>{{ describeRuleHours(rule) }}</strong>
        <div class="small muted">
          {{ describeRuleDays(rule) }} · {{ describeRuleInterval(rule) }}
        </div>
      </div>
      <button class="danger" @click="removeRule(index)">Remove</button>
    </div>

    <div class="field" style="margin-top: 12px">
      <label>Add a rule</label>

      <div class="small muted" style="margin-bottom: 4px">On these days</div>
      <div class="row" style="flex-wrap: wrap; gap: 4px">
        <button
          v-for="(short, index) in DAY_SHORT"
          :key="index"
          class="secondary"
          :class="{ 'is-selected': days.includes(index) }"
          :title="DAY_NAMES[index]"
          @click="toggleDay(index)"
        >
          {{ short }}
        </button>
        <button class="secondary" @click="chooseAll">
          {{ days.length === 7 ? "None" : "Every day" }}
        </button>
      </div>

      <div class="row">
        <div class="field grow">
          <label for="rule-start">From</label>
          <input id="rule-start" v-model="startText" placeholder="00:00" />
        </div>
        <div class="field grow">
          <label for="rule-end">Until</label>
          <input id="rule-end" v-model="endText" placeholder="24:00" />
        </div>
      </div>

      <label class="check small">
        <input v-model="still" type="checkbox" />
        Nothing is shown during these hours
      </label>

      <div v-if="!still" class="row">
        <div class="field grow">
          <label for="rule-count">Change the picture every</label>
          <input id="rule-count" v-model.number="count" type="number" min="1" />
        </div>
        <div class="field grow">
          <label for="rule-unit">&nbsp;</label>
          <select id="rule-unit" v-model="unit">
            <option value="minutes">minutes</option>
            <option value="hours">hours</option>
            <option value="days">days</option>
          </select>
        </div>
      </div>

      <div v-if="!withinLimit" class="error small">
        The picture cannot change less often than {{ limitText }}, because
        it can only change on the days chosen.
      </div>

      <button :disabled="!withinLimit" @click="addRule">Add rule</button>
    </div>
  </template>
</template>

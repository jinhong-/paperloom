import { createRouter, createWebHistory } from "vue-router";

import { useSessionStore } from "@/stores/session";
import { appBase } from "@/lib/base";
import ClaimView from "@/views/ClaimView.vue";
import DevicesView from "@/views/DevicesView.vue";
import GalleriesView from "@/views/GalleriesView.vue";
import InvitationView from "@/views/InvitationView.vue";
import LoginView from "@/views/LoginView.vue";
import PeopleView from "@/views/PeopleView.vue";
import SetupView from "@/views/SetupView.vue";
import TelegramView from "@/views/TelegramView.vue";

/**
 * The pages that can be seen without signing in.
 *
 * The claim page is here because the person following a frame's claim
 * code may not have an account yet.
 *
 * The setup page is here because it is the page that makes the first
 * account, so it cannot need one.
 */
const publicRoutes = new Set(["login", "invitation", "claim", "setup"]);

export const router = createRouter({
  /* The base has to be the prefix the app is served from, worked out
   * from the script's own address.
   *
   * The build's base is relative, and a relative base is resolved once,
   * when the router is made, which is before the app knows where it is.
   * The pages it links to then point at the root rather than at the
   * prefix, and the app goes nowhere when they are followed. */
  history: createWebHistory(appBase()),
  routes: [
    /* The root shows the galleries.
     *
     * It is the same page under another name rather than a redirect,
     * because a redirect is a second journey: the page would be blank
     * while the first one finished and the second one began. */
    { path: "/", name: "home", component: GalleriesView },
    { path: "/login", name: "login", component: LoginView },
    { path: "/setup", name: "setup", component: SetupView },
    { path: "/invitation/:code", name: "invitation", component: InvitationView },
    { path: "/people", name: "people", component: PeopleView },
    { path: "/galleries", name: "galleries", component: GalleriesView },
    { path: "/devices", name: "devices", component: DevicesView },
    { path: "/telegram", name: "telegram", component: TelegramView },
    { path: "/claim/:code", name: "claim", component: ClaimView },
  ],
});

/**
 * Ask whether the server still has no owner, once.
 */
async function setupState(session: ReturnType<typeof useSessionStore>): Promise<void> {
  if (!session.setupChecked) {
    await session.refreshSetup();
  }
}

/**
 * Keep the pages that need a session behind the sign-in page.
 *
 * A page that needs a session is not shown to somebody who has not got
 * one: they are sent to the sign-in page instead, and come back to where
 * they were once they have signed in.
 *
 * A server with no owner is the one exception: it has nobody to sign in
 * yet, so the setup page is sent instead. Otherwise the first person to
 * open the server is left staring at a sign-in form they cannot use.
 */
router.beforeEach(async (to) => {
  if (publicRoutes.has(String(to.name))) {
    return true;
  }

  const session = useSessionStore();

  /* The session is asked about once, on the first page that is opened,
   * and the answer is kept.
   *
   * The two questions are asked together rather than one after the other.
   * Asking them in turn means the page waits for two journeys to and fro
   * before it knows where to send the owner, and it is blank for the
   * whole of it. */
  if (!session.checked) {
    await Promise.all([session.refresh(), setupState(session)]);
  }

  if (session.signedIn()) {
    return true;
  }

  /* The sign-in page is where they were going anyway. */
  if (to.name === "login") {
    return true;
  }

  /* A server with no owner cannot be signed in to, so the setup page is
   * the way in. */
  if (session.setupOpen === true) {
    return { name: "setup", query: { next: to.fullPath } };
  }

  return { name: "login", query: { next: to.fullPath } };
});

/**
 * Keep the setup page for the server that has no owner.
 *
 * Once the owner exists, the setup page has nothing left to offer, so
 * anybody who goes there is sent to the sign-in page. This stops the
 * setup page from being used as a way of trying to make a second
 * account.
 */
router.afterEach(async (to) => {
  if (to.name !== "setup") {
    return;
  }

  const session = useSessionStore();

  if (session.signedIn()) {
    return;
  }

  await setupState(session);
  if (session.setupOpen !== true) {
    router.replace({ name: "login" });
  }
});

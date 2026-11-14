import { createRouter, createWebHistory } from "vue-router";

import ClaimView from "@/views/ClaimView.vue";
import DevicesView from "@/views/DevicesView.vue";
import GalleriesView from "@/views/GalleriesView.vue";
import InvitationView from "@/views/InvitationView.vue";
import LoginView from "@/views/LoginView.vue";
import PeopleView from "@/views/PeopleView.vue";
import RegisterView from "@/views/RegisterView.vue";

/**
 * The pages that can be seen without signing in.
 *
 * The claim page is here because the person following a frame's claim
 * code may not have an account yet.
 */
const publicRoutes = new Set(["login", "register", "invitation", "claim"]);

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/galleries" },
    { path: "/login", name: "login", component: LoginView },
    { path: "/register", name: "register", component: RegisterView },
    { path: "/invitation/:code", name: "invitation", component: InvitationView },
    { path: "/people", name: "people", component: PeopleView },
    { path: "/galleries", name: "galleries", component: GalleriesView },
    { path: "/devices", name: "devices", component: DevicesView },
    { path: "/claim/:code", name: "claim", component: ClaimView },
  ],
});

/**
 * Keep the pages that need a session behind the sign-in page.
 *
 * A page that needs a session is not shown to somebody who has not got
 * one: they are sent to the sign-in page instead, and come back to where
 * they were once they have signed in.
 */
router.beforeEach(async (to) => {
  if (publicRoutes.has(String(to.name))) {
    return true;
  }

  const { useSessionStore } = await import("@/stores/session");
  const session = useSessionStore();

  /* The session is asked about once, on the first page that is opened,
   * and the answer is kept. */
  if (!session.checked) {
    await session.refresh();
  }

  if (session.signedIn()) {
    return true;
  }

  /* The sign-in page is where they were going anyway. */
  if (to.name === "login") {
    return true;
  }

  return { name: "login", query: { next: to.fullPath } };
});

import { createRouter, createWebHistory } from "vue-router";

import ClaimView from "@/views/ClaimView.vue";
import DevicesView from "@/views/DevicesView.vue";
import GalleriesView from "@/views/GalleriesView.vue";
import LoginView from "@/views/LoginView.vue";
import RegisterView from "@/views/RegisterView.vue";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/galleries" },
    { path: "/login", name: "login", component: LoginView },
    { path: "/register", name: "register", component: RegisterView },
    { path: "/galleries", name: "galleries", component: GalleriesView },
    { path: "/devices", name: "devices", component: DevicesView },
    { path: "/claim/:code", name: "claim", component: ClaimView },
  ],
});

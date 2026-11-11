/**
 * The session store.
 *
 * Holds the signed-in user and the loaded galleries and devices.
 */

import { defineStore } from "pinia";
import { ref } from "vue";

import { api, type Device, type Gallery } from "@/api";

export const useSessionStore = defineStore("session", () => {
  const username = ref<string | null>(null);
  const galleries = ref<Gallery[]>([]);
  const devices = ref<Device[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * Whether a user is signed in.
   */
  const signedIn = () => username.value !== null;

  /**
   * Load the current session, if there is one.
   */
  async function refresh(): Promise<void> {
    try {
      const user = await api.me();
      username.value = user.username;
    } catch {
      username.value = null;
    }
  }

  /**
   * Sign in.
   */
  async function login(name: string, password: string): Promise<void> {
    await api.login(name, password);
    await refresh();
  }

  /**
   * Create an account and sign in.
   */
  async function register(name: string, password: string): Promise<void> {
    await api.register(name, password);
    await login(name, password);
  }

  /**
   * Sign out.
   */
  async function logout(): Promise<void> {
    await api.logout();
    username.value = null;
    galleries.value = [];
    devices.value = [];
  }

  /**
   * Reload the galleries and devices.
   */
  async function reload(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      const [g, d] = await Promise.all([api.galleries(), api.devices()]);
      galleries.value = g;
      devices.value = d;
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      loading.value = false;
    }
  }

  return {
    username,
    galleries,
    devices,
    loading,
    error,
    signedIn,
    refresh,
    login,
    register,
    logout,
    reload,
  };
});

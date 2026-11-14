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
   * Whether the user is signed in.
   */
  const signedIn = () => username.value !== null;

  /**
   * Whether the session has been looked at.
   *
   * The session is asked about once, when the first page is opened. The
   * answer is kept, so that moving between the pages does not ask the
   * server again.
   */
  const checked = ref(false);

  /**
   * Whether the server still has no owner.
   *
   * Only the first account may be made without an invitation, so this
   * decides whether the setup page is offered at all.
   *
   * It is null when the server could not be asked, which is different
   * from being asked and told no.
   */
  const setupOpen = ref<boolean | null>(null);

  /**
   * Whether the setup state has been looked at.
   */
  const setupChecked = ref(false);

  /**
   * Load the current session, if there is one.
   */
  async function refresh(): Promise<void> {
    try {
      const user = await api.me();
      username.value = user.username;
    } catch {
      username.value = null;
    } finally {
      checked.value = true;
    }
  }

  /**
   * Ask whether the server still has no owner.
   *
   * The answer is kept, so that moving between the pages does not ask
   * the server again.
   */
  async function refreshSetup(): Promise<void> {
    try {
      const result = await api.registrationOpen();
      setupOpen.value = result.open;
    } catch {
      /* If the server cannot be asked, it is not known whether the
       * setup page is allowed, so it is not offered. The server will
       * refuse it anyway if it is not. */
      setupOpen.value = false;
    } finally {
      setupChecked.value = true;
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
   * Create the owner account.
   *
   * This is only possible while the server has no owner. Once the owner
   * exists, everybody else has to be invited.
   */
  async function becomeOwner(name: string, password: string): Promise<void> {
    await api.register(name, password);
    await login(name, password);
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
    checked,
    setupOpen,
    setupChecked,
    refresh,
    refreshSetup,
    login,
    register,
    becomeOwner,
    logout,
    reload,
  };
});

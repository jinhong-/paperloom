/**
 * Where the app is served from.
 *
 * The built UI refers to its assets relatively, so that it works behind
 * Home Assistant's path-prefixed ingress endpoint. The app has to know
 * that prefix as well, for the pages it links to and for the API it
 * calls: an absolute path would leave the prefix and go to Home
 * Assistant itself.
 *
 * The prefix is taken from the address the app's own script was loaded
 * from, which is exactly where the app is being served: the script sits
 * at <prefix>/assets/app.js, so the prefix is what comes before
 * /assets/.
 */

/**
 * The prefix the app is served from, with its trailing slash.
 *
 * The base is worked out once and kept, because the pages and the API
 * both need it and they must agree.
 */
let cachedBase: string | null = null;

export function appBase(): string {
  if (cachedBase !== null) return cachedBase;

  const scripts = Array.from(
    document.querySelectorAll<HTMLScriptElement>("script[src]"),
  );
  const script = scripts.find((element) => element.src.includes("/assets/"));

  if (!script) {
    /* No script to learn the prefix from. The server is then at the root
     * of wherever the page is, which is the case when it is not behind a
     * path prefix. */
    cachedBase = "/";
    return cachedBase;
  }

  /* The script is at <prefix>/assets/app.js. The prefix is what comes
   * before /assets/, and it keeps its trailing slash so that the address
   * is put together with exactly one slash between the parts.
   *
   * It is a path and not a whole address: the router is given it as the
   * place the app lives, and a whole address would be treated as a path
   * and put in front of everything else. */
  const index = script.src.indexOf("/assets/");
  cachedBase = index >= 0 ? script.src.slice(0, index + 1).replace(/^https?:\/\/[^/]+/, "") : "/";
  return cachedBase;
}

/**
 * The address of something on the server.
 *
 * The base keeps its trailing slash and the path loses its leading one,
 * so that the two are put together with exactly one slash between them.
 *
 * Doing this in one place matters: an address with two slashes in it is
 * not the same address, and the server does not answer it.
 *
 * The address is a path, which the browser resolves against the page. It
 * is the same path the router uses, so the pages and the API are always
 * looked for in the same place.
 */
export function appUrl(path: string): string {
  return `${appBase()}${path.replace(/^\//, "")}`;
}

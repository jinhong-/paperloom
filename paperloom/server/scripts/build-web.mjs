/**
 * Build the management UI after the server's dependencies are installed.
 *
 * The UI is a separate npm project in server/web, so it needs its own
 * dependencies and its own build. Doing it here means a single
 * `npm install` in server/ leaves you with a complete, working server
 * rather than an API with no interface.
 *
 * The build is skipped, quietly, when:
 *
 *   - the web project has no dependencies installed, which is the case
 *     when npm is run with --ignore-scripts;
 *   - the build fails, because a missing interface should not stop the
 *     server's own dependencies from being installed. The server logs a
 *     warning at startup if the UI is missing.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "web");

// Without the web project's dependencies there is nothing to build with.
// npm workspaces may hoist them to the parent directory, so both places
// are checked.
const hasDependencies =
  existsSync(join(webDir, "node_modules")) ||
  existsSync(join(dirname(webDir), "node_modules", "vite"));

if (!hasDependencies) {
  process.exit(0);
}

// npm on Windows is npm.cmd, which cannot be run directly.
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

const result = spawnSync(npm, ["run", "build"], {
  cwd: webDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.status !== 0) {
  console.warn(
    "\nThe management UI could not be built. The server will still run, but it " +
      "will not serve the web interface.\n" +
      "Run 'npm run build:web' in server/web once the problem is fixed.\n",
  );
}

process.exit(0);

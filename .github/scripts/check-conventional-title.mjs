#!/usr/bin/env node
/**
 * Validate a pull request title against the Conventional Commits format.
 *
 * This is intentionally implemented in the repository instead of using a
 * third-party action. The repository's Enterprise policy restricts the
 * Actions that may be used, and this check has no dependencies.
 */

const title = process.env.PR_TITLE?.trim() ?? "";

const types = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

const pattern = new RegExp(
  `^(?<type>${types.join("|")})(?<breaking>!)?(?<scope>\\([\\w.-]+\\))?: .+$`,
);

if (!title) {
  console.error("The pull request title is empty.");
  process.exit(1);
}

const match = pattern.exec(title);
if (!match?.groups) {
  console.error("The pull request title does not follow Conventional Commits.");
  console.error("");
  console.error("Expected: <type>[(optional scope)]: <description>");
  console.error("");
  console.error(`Accepted types: ${types.join(", ")}`);
  console.error("");
  console.error("Examples:");
  console.error("  fix: prevent duplicate gallery assignments");
  console.error("  feat(web): add gallery categories");
  console.error("  feat!: change the device enrollment protocol");
  process.exit(1);
}

const { type, scope, breaking } = match.groups;
console.log(
  `Conventional commit title accepted: type=${type}${
    scope ? `, scope=${scope.slice(1, -1)}` : ""
  }${breaking ? ", breaking=true" : ""}`,
);

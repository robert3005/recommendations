/**
 * One-command deploy of the web app's test deployment (OPERATIONS.md):
 * build with the committed settings in deploy.env plus the git-ignored
 * deploy.env.local (keys, personal overrides), then publish dist/ as the
 * placemarks-web Worker. `--build-only` stops before publishing.
 *
 * The settings live in their own files rather than .env.production so that
 * a plain `vite build` — the build tests, CI — never picks them up.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const env = { ...process.env };
// Later files win, and both win over the shell, so a deploy is the same
// whatever happens to be exported in the terminal it runs from.
for (const name of ["deploy.env", "deploy.env.local"]) {
  const file = resolve(root, name);
  if (existsSync(file)) Object.assign(env, parseEnv(readFileSync(file, "utf8")));
}

if (!env.VITE_STADIA_KEY) {
  console.warn(
    "deploy: no VITE_STADIA_KEY in deploy.env.local — place search only works " +
      "if the site's domain is registered in the Stadia dashboard.",
  );
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["exec", "vite", "build"]);
if (!process.argv.includes("--build-only")) run("pnpm", ["exec", "wrangler", "deploy"]);

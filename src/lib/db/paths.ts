/**
 * Where on-disk resources live: the SQL migrations and the local PGlite data directory.
 *
 * They belong to the project, not to whatever directory the server happened to be started
 * from. `next dev <dir>` and `next start <dir>` can be launched from anywhere — an IDE preview
 * pane or a process manager does exactly that — and a path resolved against the working
 * directory alone then points at nothing: the database fails to open and every request that
 * needs it answers 500.
 *
 * next.config.ts records where the project is relative to the launch directory
 * (PACT_PROJECT_DIR, inlined when the server code is compiled). It is empty whenever the server
 * is started from the project root — `npm run dev`, `npm start`, Vercel — and unset in plain
 * Node (tests, scripts), so in all of those the working directory is used unchanged.
 */
import path from "node:path";

function relativeProjectDir(): string {
  // Spelled out in full: the bundler substitutes this exact expression.
  return process.env.PACT_PROJECT_DIR ?? "";
}

/**
 * An absolute path for a project resource. A `target` that is already absolute is returned as
 * it is, so an operator can still point the data directory anywhere.
 */
export function projectPath(target: string, launchDir: string = process.cwd(), projectDir: string = relativeProjectDir()): string {
  return path.resolve(launchDir, projectDir, target);
}

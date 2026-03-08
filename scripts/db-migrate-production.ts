import { spawnSync } from "node:child_process"

const defaultProjectRef = "hdeyrmgwudbmnanlsmll"
const projectRef = process.env.SUPABASE_PROJECT_REF?.trim() || defaultProjectRef
const rawArgs = process.argv.slice(2).filter((arg) => arg !== "--")
const allowedArgs = new Set(["--write"])
const unknownArgs = rawArgs.filter((arg) => !allowedArgs.has(arg))

if (unknownArgs.length > 0) {
  console.error(
    `Unknown argument${unknownArgs.length === 1 ? "" : "s"}: ${unknownArgs.join(", ")}`,
  )
  console.error("Usage: bun run db:migrate:production [--write]")
  process.exit(1)
}

const write = rawArgs.includes("--write")

function run(command: string, args: string[]): number {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
  })

  if (result.error) {
    throw result.error
  }

  return result.status ?? 1
}

function isAuthenticated(): boolean {
  const result = spawnSync("bunx", ["supabase", "projects", "list"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })

  if (result.error) {
    throw result.error
  }

  return (result.status ?? 1) === 0
}

function ensureLinkedProject(): void {
  if (!isAuthenticated()) {
    console.log("\nSupabase CLI is not authenticated. Starting interactive login...\n")

    const loginExitCode = run("bunx", ["supabase", "login"])
    if (loginExitCode !== 0) {
      process.exit(loginExitCode)
    }
  }

  const linkExitCode = run("bunx", [
    "supabase",
    "link",
    "--project-ref",
    projectRef,
  ])

  if (linkExitCode !== 0) {
    process.exit(linkExitCode)
  }
}

function pushMigrations(): void {
  const pushArgs = ["supabase", "db", "push"]

  if (!write) {
    pushArgs.push("--dry-run")
  }

  const exitCode = run("bunx", pushArgs)
  if (exitCode !== 0) {
    process.exit(exitCode)
  }
}

console.log(
  `Running production migration${write ? "" : " dry run"} for Supabase project ${projectRef}.`,
)

ensureLinkedProject()
pushMigrations()

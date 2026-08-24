import postgres from "postgres";
import { parseArgs } from "@std/cli/parse-args";

const args = parseArgs(Deno.args, {
  string: ["dir"],
  boolean: ["seed"],
  default: {
    dir: "migrations",
    seed: false,
  },
});

const command = args._[0] as string | undefined;

if (
  command !== "up" &&
  command !== "down" &&
  command !== "reset" &&
  command !== "seed"
) {
  console.log(
    "Usage: migrate.ts [--dir <path>] [--seed] <up|down|reset|seed>",
  );
  console.log("  --dir   Migrations directory (default: migrations)");
  console.log("  --seed  Apply seed data after reset");
  console.log("  reset   Drop the llm schema (+ tracking) and re-apply all");
  console.log("  seed    Apply seed data (seeds/development.sql)");
  Deno.exit(1);
}

// Migrations run as the privileged owner role. The two-pool model names the
// owner connection BYPASSRLS_DATABASE_URL (the api's adminSql); accept either
// DATABASE_URL or BYPASSRLS_DATABASE_URL so this works from any package's env.
const databaseUrl = Deno.env.get("DATABASE_URL") ??
  Deno.env.get("BYPASSRLS_DATABASE_URL");
if (!databaseUrl) {
  console.error("DATABASE_URL (or BYPASSRLS_DATABASE_URL) is required");
  Deno.exit(1);
}

const sql = postgres(databaseUrl);
const migrationsDir = args.dir;

// MIGRATE_ROLE: the role migration DDL is executed as. This runner has always
// assumed `postgres` unconditionally, so that stays the default — dropping the
// role switch when the variable is unset would silently change who owns new
// objects in production. MIGRATE_ROLE only lets an operator name a different
// role; it works when the DATABASE_URL login role is a member of that role.
const migrateRole = Deno.env.get("MIGRATE_ROLE") ?? "postgres";
if (!/^[a-z_][a-z0-9_]*$/.test(migrateRole)) {
  console.error(`MIGRATE_ROLE is not a valid role name: ${migrateRole}`);
  Deno.exit(1);
}

async function ensureMigrationsTable() {
  await sql`CREATE SCHEMA IF NOT EXISTS migrations`;
  await sql`
    CREATE TABLE IF NOT EXISTS migrations.schema_migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      hash TEXT
    )
  `;
}

async function computeHash(content: string): Promise<string> {
  const data = new TextEncoder().encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hashBuffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function getApplied(): Promise<Set<string>> {
  const rows = await sql<
    { filename: string }[]
  >`SELECT filename FROM migrations.schema_migrations ORDER BY filename`;
  return new Set(rows.map((r) => r.filename));
}

async function verifyIntegrity(
  migrations: { filename: string; content: string }[],
) {
  const rows = await sql<
    { filename: string; hash: string | null }[]
  >`SELECT filename, hash FROM migrations.schema_migrations ORDER BY filename`;

  const filesByName = new Map(migrations.map((m) => [m.filename, m]));
  const errors: string[] = [];

  for (const row of rows) {
    if (!row.hash) continue;
    const migration = filesByName.get(row.filename);
    if (!migration) continue;
    const currentHash = await computeHash(migration.content);
    if (currentHash !== row.hash) {
      errors.push(
        `${row.filename}: file has been modified after it was applied`,
      );
    }
  }

  if (errors.length > 0) {
    console.error("Migration integrity check failed:");
    for (const err of errors) {
      console.error(`  - ${err}`);
    }
    Deno.exit(1);
  }
}

async function backfillHashes(
  migrations: { filename: string; content: string }[],
) {
  const rows = await sql<
    { filename: string }[]
  >`SELECT filename FROM migrations.schema_migrations WHERE hash IS NULL`;

  const filesByName = new Map(migrations.map((m) => [m.filename, m]));

  for (const row of rows) {
    const migration = filesByName.get(row.filename);
    if (!migration) continue;
    const hash = await computeHash(migration.content);
    await sql`UPDATE migrations.schema_migrations SET hash = ${hash} WHERE filename = ${row.filename}`;
    console.log(`Backfilled hash for ${row.filename}`);
  }
}

async function readMigrations(
  direction: "up" | "down",
): Promise<{ filename: string; content: string }[]> {
  const entries: { filename: string; content: string }[] = [];

  for await (const entry of Deno.readDir(migrationsDir)) {
    if (entry.isFile && entry.name.endsWith(`.${direction}.sql`)) {
      const content = await Deno.readTextFile(`${migrationsDir}/${entry.name}`);
      entries.push({ filename: entry.name, content });
    }
  }

  entries.sort((a, b) => a.filename.localeCompare(b.filename));
  return entries;
}

async function up() {
  await ensureMigrationsTable();
  const applied = await getApplied();
  const migrations = await readMigrations("up");

  await verifyIntegrity(migrations);
  await backfillHashes(migrations);

  const pending = migrations.filter((m) => !applied.has(m.filename));

  if (pending.length === 0) {
    console.log("No pending migrations.");
    return;
  }

  for (const migration of pending) {
    console.log(`Applying ${migration.filename}...`);
    const hash = await computeHash(migration.content);
    await sql.begin(async (tx) => {
      // Run migration DDL as `postgres` so every object is owned by postgres,
      // regardless of which login role the platform connects us as. This keeps
      // the non-owner, NOBYPASSRLS `app_user` request role subject to RLS.
      // RESET before bookkeeping so the insert uses the login role (which owns
      // the migrations table) rather than depending on postgres's grants.
      await tx.unsafe(`SET ROLE ${migrateRole}`);
      await tx.unsafe(migration.content);
      await tx`RESET ROLE`;
      await tx`INSERT INTO migrations.schema_migrations (filename, hash) VALUES (${migration.filename}, ${hash})`;
    });
    console.log(`Applied ${migration.filename}`);
  }
}

async function down() {
  await ensureMigrationsTable();
  const applied = await getApplied();

  if (applied.size === 0) {
    console.log("No migrations to roll back.");
    return;
  }

  const lastApplied = [...applied].sort().pop()!;
  const baseName = lastApplied.replace(".up.sql", "");
  const downFilename = `${baseName}.down.sql`;

  const allDown = await readMigrations("down");
  const downMigration = allDown.find((m) => m.filename === downFilename);

  if (!downMigration) {
    console.error(`Down migration not found: ${downFilename}`);
    Deno.exit(1);
  }

  console.log(`Rolling back ${lastApplied}...`);
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET ROLE ${migrateRole}`);
    await tx.unsafe(downMigration.content);
    await tx`RESET ROLE`;
    await tx`DELETE FROM migrations.schema_migrations WHERE filename = ${lastApplied}`;
  });
  console.log(`Rolled back ${lastApplied}`);
}

async function seed(seedFile = "seeds/development.sql") {
  try {
    const content = await Deno.readTextFile(seedFile);
    console.log(`Applying seed: ${seedFile}...`);
    await sql.unsafe(content);
    console.log(`Seed applied: ${seedFile}`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      console.error(`Seed file not found: ${seedFile}`);
      Deno.exit(1);
    }
    throw err;
  }
}

async function reset() {
  if (
    !databaseUrl!.includes("localhost") &&
    !databaseUrl!.includes("127.0.0.1")
  ) {
    console.error("reset is only allowed on local databases");
    Deno.exit(1);
  }

  // All kamu-llm-gateway objects live in the `llm` schema, and migration
  // bookkeeping in `migrations`. Global roles (app_user/authenticated/anon)
  // are created externally / guarded in the migration, so they are left intact
  // across a reset.
  console.log("Dropping llm + migrations schemas...");
  await sql`DROP SCHEMA IF EXISTS llm CASCADE`;
  await sql`DROP SCHEMA IF EXISTS migrations CASCADE`;

  console.log("Re-applying all migrations...");
  await up();

  if (args.seed) {
    await seed();
  }
}

if (command === "up") {
  await up();
} else if (command === "down") {
  await down();
} else if (command === "seed") {
  await seed(args._[1] as string | undefined);
} else {
  await reset();
}

await sql.end();

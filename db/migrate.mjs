import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "migrations");

function splitSql(text) {
  const stripped = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

function sslConfig(connectionString) {
  const ca = process.env.DATABASE_CA_CERT?.trim();
  if (ca) return { ca, rejectUnauthorized: true };
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return undefined;
  return { rejectUnauthorized: false };
}

async function apply(exec, all, files) {
  await exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const rows = await all("SELECT filename FROM schema_migrations");
  const applied = new Set(rows.map((row) => row.filename));
  for (const file of files) {
    if (applied.has(file)) continue;
    if ((file === "0008_telegram_alerts.sql" || file === "0009_telegram_milestones.sql") && process.env.ALLOW_ALERT_MIGRATIONS !== "1") continue;
    const sqlText = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    for (const statement of splitSql(sqlText)) {
      await exec(statement);
    }
    await exec(`INSERT INTO schema_migrations (filename) VALUES ('${file.replace(/'/g, "''")}')`);
    console.log(`applied ${file}`);
  }
}

async function main() {
  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (databaseUrl) {
    const pg = await import("pg");
    const client = new pg.default.Client({
      connectionString: databaseUrl,
      ssl: sslConfig(databaseUrl),
    });
    await client.connect();
    try {
      await apply(
        (statement) => client.query(statement),
        async (statement) => (await client.query(statement)).rows,
        files,
      );
      console.log("migrations applied to DATABASE_URL");
    } finally {
      await client.end();
    }
    return;
  }

  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PGLITE !== "1") {
    console.log("DATABASE_URL is not set; skipping migrate (production refuses embedded Postgres).");
    return;
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR || path.join(process.cwd(), ".data", "pglite");
  fs.mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  try {
    await apply(
      (statement) => db.exec(statement),
      async (statement) => (await db.query(statement)).rows,
      files,
    );
    console.log(`migrations applied to embedded Postgres at ${dir}`);
  } finally {
    await db.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

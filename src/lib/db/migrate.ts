import fs from "node:fs";
import path from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { asRows } from "@/lib/db/rows";

type Executor = {
  execute: (query: SQL) => unknown;
};

function splitSql(text: string): string[] {
  const stripped = text
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return stripped
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function applyMigrations(db: Executor): Promise<string[]> {
  await db.execute(sql.raw(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`));
  const existing = asRows<{ filename: string }>(
    await db.execute(sql.raw("SELECT filename FROM schema_migrations")),
  );
  const applied = new Set(existing.map((row) => row.filename));
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = fs.readdirSync(dir).filter((name) => name.endsWith(".sql")).sort();
  const fresh: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const isAlertMigration = file === "0008_telegram_alerts.sql" || file === "0009_telegram_milestones.sql";
    const isPaperMigration = file === "0010_paper_trading.sql";
    if (isAlertMigration && process.env.ALLOW_ALERT_MIGRATIONS !== "1") continue;
    // Paper trading migration requires alert tables to exist first
    if (isPaperMigration && process.env.ALLOW_ALERT_MIGRATIONS !== "1") continue;
    const text = fs.readFileSync(path.join(dir, file), "utf8");
    for (const statement of splitSql(text)) {
      await db.execute(sql.raw(statement));
    }
    await db.execute(sql`INSERT INTO schema_migrations (filename) VALUES (${file})`);
    fresh.push(file);
  }
  return fresh;
}

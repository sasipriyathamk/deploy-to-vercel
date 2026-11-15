import fs from "node:fs";
import path from "node:path";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite, type PgliteDatabase } from "drizzle-orm/pglite";
import pg from "pg";
import * as schema from "@/lib/db/schema";
import { applyMigrations } from "@/lib/db/migrate";

export type AppDb = NodePgDatabase<typeof schema> | PgliteDatabase<typeof schema>;

export class DatabaseNotConfigured extends Error {
  constructor() {
    super("DATABASE_URL is not set. Add a Postgres connection string before deploying.");
    this.name = "DatabaseNotConfigured";
  }
}

type DatabaseHandle = {
  db: AppDb;
  mode: "postgres" | "pglite";
};

const globalState = globalThis as typeof globalThis & {
  __keelDb?: Promise<DatabaseHandle>;
};

function sslConfig(connectionString: string): pg.ConnectionConfig["ssl"] {
  const ca = process.env.DATABASE_CA_CERT?.trim();
  if (ca) return { ca, rejectUnauthorized: true };
  if (/localhost|127\.0\.0\.1/.test(connectionString)) return undefined;
  return { rejectUnauthorized: false };
}

async function openDatabase(): Promise<DatabaseHandle> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) {
    const pool = new pg.Pool({
      connectionString: databaseUrl,
      max: 3,
      ssl: sslConfig(databaseUrl),
    });
    const db = drizzlePg(pool, { schema });
    await applyMigrations(db);
    return { db, mode: "postgres" };
  }

  if (process.env.NODE_ENV === "production" && process.env.ALLOW_PGLITE !== "1") {
    throw new DatabaseNotConfigured();
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const dir = process.env.PGLITE_DIR || path.join(process.cwd(), ".data", "pglite");
  fs.mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzlePglite(client, { schema });
  await applyMigrations(db);
  console.info(`[keel] embedded Postgres at ${dir}. Set DATABASE_URL for Vercel.`);
  return { db, mode: "pglite" };
}

export async function getDatabase(): Promise<DatabaseHandle> {
  if (!globalState.__keelDb) {
    globalState.__keelDb = openDatabase().catch((error) => {
      globalState.__keelDb = undefined;
      throw error;
    });
  }
  return globalState.__keelDb;
}

export async function getDb(): Promise<AppDb> {
  return (await getDatabase()).db;
}

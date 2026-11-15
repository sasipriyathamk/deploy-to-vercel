import { getDatabase } from "@/lib/db/index";
import { pollWallets, processQueue } from "@/lib/pipeline";

const state = globalThis as typeof globalThis & { __keelWorker?: boolean };

export async function boot(): Promise<void> {
  await getDatabase();
  const localWorker = process.env.NODE_ENV !== "production" || process.env.ENABLE_LOCAL_WORKER === "1";
  if (!localWorker || state.__keelWorker) return;
  state.__keelWorker = true;
  setInterval(() => {
    getDatabase()
      .then(({ db }) => processQueue(db, 8, 12_000))
      .catch((error) => console.error("[keel] worker", error));
  }, 15_000);
  if (process.env.POLL_ON_BOOT === "1") {
    getDatabase()
      .then(({ db }) => pollWallets(db))
      .catch((error) => console.error("[keel] poll", error));
  }
}

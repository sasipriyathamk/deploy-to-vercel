import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { HolderThesis } from "@/lib/ai/types";
import type { AlertPath, CapRegime } from "@/lib/logic/confidence";
import type { TokenSocials } from "@/lib/logic/quality";
import type { ScoreBreakdown } from "@/lib/logic/score";

export const wallets = pgTable("wallets", {
  address: text("address").primaryKey(),
  label: text("label").notNull().default(""),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastSignature: text("last_signature"),
  resumeBefore: text("resume_before"),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: "date" }),
  lastIngestAt: timestamp("last_ingest_at", { withTimezone: true, mode: "date" }),
});

export const rawEvents = pgTable(
  "raw_events",
  {
    signature: text("signature").primaryKey(),
    wallet: text("wallet").notNull(),
    slot: bigint("slot", { mode: "number" }),
    blockTime: timestamp("block_time", { withTimezone: true, mode: "date" }),
    err: boolean("err").notNull().default(false),
    programs: text("programs").array().notNull().default([]),
    mint: text("mint"),
    side: text("side").notNull().default("unknown"),
    solDelta: doublePrecision("sol_delta"),
    tokenDelta: doublePrecision("token_delta"),
    rawJson: jsonb("raw_json"),
    ingestedAt: timestamp("ingested_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("raw_events_wallet_time").on(table.wallet, table.blockTime),
    index("raw_events_mint").on(table.mint),
  ],
);

export const tokens = pgTable(
  "tokens",
  {
    mint: text("mint").primaryKey(),
    symbol: text("symbol"),
    name: text("name"),
    imageUrl: text("image_url"),
    decimals: integer("decimals"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: "date" }),
    firstSeenPriceUsd: doublePrecision("first_seen_price_usd"),
    firstSeenMcapUsd: doublePrecision("first_seen_mcap_usd"),
    sniperBuyPriceUsd: doublePrecision("sniper_buy_price_usd"),
    sniperBuyMcapUsd: doublePrecision("sniper_buy_mcap_usd"),
    sniperBuySol: doublePrecision("sniper_buy_sol"),
    sniperBuyTx: text("sniper_buy_tx"),
    sniperBuyAt: timestamp("sniper_buy_at", { withTimezone: true, mode: "date" }),
    sniperWallet: text("sniper_wallet"),
    entryAt: timestamp("entry_at", { withTimezone: true, mode: "date" }),
    entryPriceUsd: doublePrecision("entry_price_usd"),
    entryMcapUsd: doublePrecision("entry_mcap_usd"),
    status: text("status").notNull().default("seen"),
    score: integer("score").notNull().default(50),
    scoreBreakdown: jsonb("score_breakdown").$type<ScoreBreakdown>(),
    lastPriceUsd: doublePrecision("last_price_usd"),
    lastMcapUsd: doublePrecision("last_mcap_usd"),
    lastLiqUsd: doublePrecision("last_liq_usd"),
    lastVolM5: doublePrecision("last_vol_m5"),
    lastVolH1: doublePrecision("last_vol_h1"),
    lastBuysM5: integer("last_buys_m5"),
    lastSellsM5: integer("last_sells_m5"),
    lastBuysH1: integer("last_buys_h1"),
    lastSellsH1: integer("last_sells_h1"),
    lastBuyersEstimate: integer("last_buyers_estimate"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true, mode: "date" }),
    gainPct: doublePrecision("gain_pct"),
    gainBasis: text("gain_basis"),
    athPriceUsd: doublePrecision("ath_price_usd"),
    athMcapUsd: doublePrecision("ath_mcap_usd"),
    athGainPct: doublePrecision("ath_gain_pct"),
    athAt: timestamp("ath_at", { withTimezone: true, mode: "date" }),
    archiveReason: text("archive_reason"),
    archivedAt: timestamp("archived_at", { withTimezone: true, mode: "date" }),
    reviveCount: integer("revive_count").notNull().default(0),
    revivedAt: timestamp("revived_at", { withTimezone: true, mode: "date" }),
    sniperStillHolding: boolean("sniper_still_holding"),
    venue: text("venue"),
    graduated: boolean("graduated").notNull().default(false),
    t5VolM5: doublePrecision("t5_vol_m5"),
    weakSince: timestamp("weak_since", { withTimezone: true, mode: "date" }),
    holdCheckedAt: timestamp("hold_checked_at", { withTimezone: true, mode: "date" }),
    pairCount: integer("pair_count"),
    topHolderPct: doublePrecision("top_holder_pct"),
    mintRevoked: boolean("mint_revoked"),
    freezeRevoked: boolean("freeze_revoked"),
    rugcheckNormalised: doublePrecision("rugcheck_normalised"),
    firstAlertAt: timestamp("first_alert_at", { withTimezone: true, mode: "date" }),
    firstAlertPriceUsd: doublePrecision("first_alert_price_usd"),
    firstAlertMcapUsd: doublePrecision("first_alert_mcap_usd"),
    confidence: integer("confidence"),
    confidencePending: integer("confidence_pending"),
    confidenceReasons: jsonb("confidence_reasons").$type<string[]>(),
    capRegime: text("cap_regime").$type<CapRegime | null>(),
    alertPath: jsonb("alert_path").$type<AlertPath | null>(),
    weakRechecks: integer("weak_rechecks").notNull().default(0),
    scorePending: integer("score_pending"),
    socials: jsonb("socials").$type<TokenSocials | null>(),
    promotionHits: text("promotion_hits"),
  },
  (table) => [
    index("tokens_status_score").on(table.status, table.score),
    index("tokens_symbol").on(table.symbol),
  ],
);

export const tokenChecks = pgTable("token_checks", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  mint: text("mint").notNull(),
  checkedAt: timestamp("checked_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  stage: text("stage").notNull(),
  payload: jsonb("payload"),
  passed: boolean("passed"),
  flags: jsonb("flags"),
});

export const pipelineJobs = pgTable(
  "pipeline_jobs",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    runAfter: timestamp("run_after", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    status: text("status").notNull().default("pending"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true, mode: "date" }),
  },
  (table) => [index("pipeline_jobs_status_run").on(table.status, table.runAfter)],
);

export const providerCalls = pgTable("provider_calls", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  provider: text("provider").notNull(),
  status: integer("status"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const marketCache = pgTable("market_cache", {
  cacheKey: text("cache_key").primaryKey(),
  payload: jsonb("payload").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
});

export const aiVerdicts = pgTable(
  "ai_verdicts",
  {
    id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
    mint: text("mint").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
    verdict: text("verdict").notNull(),
    conviction: integer("conviction"),
    bullPoints: jsonb("bull_points").$type<string[]>().notNull().default([]),
    redFlags: jsonb("red_flags").$type<string[]>().notNull().default([]),
    narrative: text("narrative"),
    invalidation: text("invalidation"),
    holderSummary: text("holder_summary"),
    reasoning: text("reasoning"),
    unavailableReason: text("unavailable_reason"),
    model: text("model"),
    inputsHash: text("inputs_hash").notNull(),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    costUsd: doublePrecision("cost_usd"),
    stage: text("stage"),
    priceUsd: doublePrecision("price_usd"),
    mcapUsd: doublePrecision("mcap_usd"),
    thesisFingerprint: text("thesis_fingerprint"),
    thesisNewestAt: timestamp("thesis_newest_at", { withTimezone: true, mode: "date" }),
    theses: jsonb("theses").$type<HolderThesis[]>().notNull().default([]),
    trigger: text("trigger").notNull(),
    countsTowardCap: boolean("counts_toward_cap").notNull().default(false),
  },
  (table) => [index("ai_verdicts_mint_created").on(table.mint, table.createdAt)],
);

/** Durable Telegram ledger; legacy firstAlertAt remains the candidate baseline. */
export const telegramAlerts = pgTable("telegram_alerts", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  mint: text("mint").notNull().unique(),
  qualifiedAt: timestamp("qualified_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  snapshotAt: timestamp("snapshot_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  confidence: integer("confidence").notNull(),
  stage: text("stage").notNull(),
  snapshot: jsonb("snapshot").notNull(),
  basis: text("basis").notNull(),
  entryValue: doublePrecision("entry_value").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", {
    withTimezone: true,
    mode: "date",
  })
    .notNull()
    .defaultNow(),
  attemptedAt: timestamp("attempted_at", { withTimezone: true, mode: "date" }),
  sentAt: timestamp("sent_at", { withTimezone: true, mode: "date" }),
  telegramMessageId: bigint("telegram_message_id", { mode: "number" }),
  deliveryError: text("delivery_error"),
  nextSnapshotAt: timestamp("next_snapshot_at", {
    withTimezone: true,
    mode: "date",
  }),
  snapshotLeaseUntil: timestamp("snapshot_lease_until", {
    withTimezone: true,
    mode: "date",
  }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
});
export const alertObservationsTable = pgTable("alert_observations", {
  id: bigint("id", { mode: "number" }).generatedAlwaysAsIdentity().primaryKey(),
  alertId: bigint("alert_id", { mode: "number" })
    .notNull()
    .references(() => telegramAlerts.id),
  eventKey: text("event_key").notNull(),
  observedAt: timestamp("observed_at", {
    withTimezone: true,
    mode: "date",
  }).notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  stage: text("stage").notNull(),
  targetAt: timestamp("target_at", { withTimezone: true, mode: "date" }),
  priceUsd: doublePrecision("price_usd"),
  mcapUsd: doublePrecision("mcap_usd"),
  snapshot: jsonb("snapshot").notNull(),
});

export const telegramAlertMilestones = pgTable("telegram_alert_milestones", {
  id: bigint("id",{mode:"number"}).generatedAlwaysAsIdentity().primaryKey(),
  alertId:bigint("alert_id",{mode:"number"}).notNull().references(()=>telegramAlerts.id),
  observationId:bigint("observation_id",{mode:"number"}).notNull().references(()=>alertObservationsTable.id),
  multiple:integer("multiple").notNull(),observedValue:doublePrecision("observed_value").notNull(),
  observedAt:timestamp("observed_at",{withTimezone:true,mode:"date"}).notNull(),
  elapsedSeconds:doublePrecision("elapsed_seconds").notNull(),snapshot:jsonb("snapshot").notNull(),
  status:text("status").notNull().default("pending"),attempts:integer("attempts").notNull().default(0),
  nextAttemptAt:timestamp("next_attempt_at",{withTimezone:true,mode:"date"}).notNull().defaultNow(),
  attemptedAt:timestamp("attempted_at",{withTimezone:true,mode:"date"}),
  sentAt:timestamp("sent_at",{withTimezone:true,mode:"date"}),
  telegramMessageId:bigint("telegram_message_id",{mode:"number"}),deliveryError:text("delivery_error"),
  createdAt:timestamp("created_at",{withTimezone:true,mode:"date"}).notNull().defaultNow(),
});

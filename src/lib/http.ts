import { NextResponse } from "next/server";
import { DatabaseNotConfigured, getDb, type AppDb } from "@/lib/db/index";

export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export async function withDb(run: (db: AppDb) => Promise<unknown>): Promise<NextResponse> {
  try {
    const db = await getDb();
    return NextResponse.json(await run(db));
  } catch (error) {
    if (error instanceof HttpError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof DatabaseNotConfigured) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    console.error(error);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}

export function cronAuthorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return process.env.NODE_ENV !== "production";
  return request.headers.get("authorization") === `Bearer ${secret}`;
}

export function webhookAuthorized(request: Request): boolean {
  const secret = process.env.HELIUS_WEBHOOK_SECRET?.trim();
  if (!secret) return true;
  const header = request.headers.get("authorization");
  const secretParam = new URL(request.url).searchParams.get("secret");
  return header === `Bearer ${secret}` || secretParam === secret;
}

export function unauthorized(): NextResponse {
  return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
}

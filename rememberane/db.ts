import { MongoClient, ObjectId, type Db, type Document } from "mongodb";
import { HttpError } from "./errors.ts";

const DEFAULT_URI = "mongodb://127.0.0.1:27017";
const DEFAULT_DB = "personal_helper";

// letters, digits, `_`, `-` and `.` (sub-collections), no leading `system.`
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const HEX24 = /^[0-9a-fA-F]{24}$/;

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connect(): Promise<Db> {
  if (db) return db;

  const uri = process.env.MONGODB_URI ?? DEFAULT_URI;
  const name = process.env.MONGODB_DB ?? DEFAULT_DB;

  const candidate = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
  await candidate.connect();
  const database = candidate.db(name);
  await database.command({ ping: 1 });

  client = candidate;
  db = database;
  return database;
}

export function database(): Db {
  if (!db) throw new Error("mongo connection is not initialised");
  return db;
}

export function collection(name: string) {
  if (!NAME_RE.test(name) || name.toLowerCase().startsWith("system.")) {
    throw new HttpError(400, "invalid collection name");
  }
  return database().collection(name);
}

export async function close(): Promise<void> {
  await client?.close();
  client = null;
  db = null;
}

/**
 * `_id` may be an ObjectId (mongo default) or a string/UUID supplied by the client,
 * so match both when the id looks like a hex ObjectId.
 */
export function idFilter(id: string): Document {
  const candidates: unknown[] = [id];
  if (HEX24.test(id)) candidates.unshift(new ObjectId(id));
  return { $in: candidates };
}

// server-side JS execution is the one thing a generic endpoint should not expose
const DENIED = new Set(["$where", "$function", "$accumulator"]);

export function assertSafe(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) assertSafe(item);
    return;
  }
  if (typeof value !== "object" || value === null) return;

  for (const [key, nested] of Object.entries(value)) {
    if (DENIED.has(key)) throw new HttpError(400, `operator ${key} is not allowed`);
    assertSafe(nested);
  }
}

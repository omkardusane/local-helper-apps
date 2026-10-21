import express, { type NextFunction, type Request, type Response } from "express";
import type { Document } from "mongodb";
import { assertSafe, close, collection, connect, database, idFilter } from "./db.ts";
import { HttpError } from "./errors.ts";

const PORT = Number(process.env.PORT ?? 3000);
const BODY_LIMIT = process.env.BODY_LIMIT ?? "10mb";
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

/* ------------------------------------------------------------------ helpers */

function stringParam(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function jsonObjectParam(raw: string | undefined, name: string): Document {
  if (raw === undefined || raw.trim() === "") return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, `\`${name}\` must be valid JSON`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, `\`${name}\` must be a JSON object`);
  }

  assertSafe(parsed);
  return parsed as Document;
}

function intParam(raw: string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new HttpError(400, `\`${name}\` must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertDocument(value: unknown, label = "document"): asserts value is Document {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, `${label} must be a JSON object`);
  }
}

/**
 * PATCH body is either a plain set of fields (wrapped in `$set`) or a mongo update
 * document using operators (`$inc`, `$push`, ...). `_id` is never updateable.
 */
function toUpdate(body: unknown): Document {
  assertDocument(body, "update");

  const update: Document = { ...body };
  delete update._id;

  const keys = Object.keys(update);
  if (keys.length === 0) throw new HttpError(400, "update body is empty");

  const operators = keys.filter((key) => key.startsWith("$"));
  if (operators.length === 0) return { $set: update };
  if (operators.length !== keys.length) {
    throw new HttpError(400, "cannot mix update operators with plain fields");
  }

  assertSafe(update);
  const set = update.$set;
  if (typeof set === "object" && set !== null) delete (set as Document)._id;
  return update;
}

function errorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

function statusForError(error: unknown): number {
  if (error instanceof HttpError) return error.status;

  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }

  switch (errorCode(error)) {
    case 11000:
      return 409; // duplicate _id / unique index
    case 66:
    case 121:
    case 2:
      return 400; // immutable field, schema validation, bad value
    case 13:
      return 403; // unauthorized
    default:
      return 500;
  }
}

/* ---------------------------------------------------------------------- app */

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: BODY_LIMIT }));

app.use((req, res, next) => {
  res.set("access-control-allow-origin", "*");
  res.set("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  res.set("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get("/", (_req, res) => {
  res.json({
    name: "personal-helper",
    database: database().databaseName,
    endpoints: [
      "GET    /health",
      "GET    /api                             list collections",
      "GET    /api/:collection                 query: filter, sort, projection, limit, skip",
      "POST   /api/:collection                 insert one object or an array of objects",
      "GET    /api/:collection/:id              read one",
      "PUT    /api/:collection/:id              replace one",
      "PATCH  /api/:collection/:id              update one ($set shorthand or operators)",
      "DELETE /api/:collection/:id              delete one",
      "DELETE /api/:collection?filter={...}     delete many (requires filter or all=true)",
    ],
  });
});

app.get("/health", async (_req, res) => {
  try {
    await database().command({ ping: 1 });
    res.json({ ok: true, database: database().databaseName, node: process.version });
  } catch {
    res.status(503).json({ ok: false, error: "mongodb unreachable" });
  }
});

// list collections (kept off `/api/:collection` so it can never clash with a name)
app.get("/api", async (_req, res) => {
  const collections = await database()
    .listCollections({}, { nameOnly: true })
    .toArray();

  res.json({
    database: database().databaseName,
    collections: collections.map((info) => info.name).filter((name) => !name.startsWith("system.")),
  });
});

app.get("/api/:collection", async (req, res) => {
  const documents = collection(req.params.collection);

  const filter = jsonObjectParam(stringParam(req.query.filter), "filter");
  const sort = jsonObjectParam(stringParam(req.query.sort), "sort");
  const projection = jsonObjectParam(stringParam(req.query.projection), "projection");
  const limit = intParam(stringParam(req.query.limit), "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
  const skip = intParam(stringParam(req.query.skip), "skip", 0, 0, Number.MAX_SAFE_INTEGER);

  const [rows, total] = await Promise.all([
    documents.find(filter, { sort, projection, limit, skip }).toArray(),
    documents.countDocuments(filter),
  ]);

  res.json({ documents: rows, count: rows.length, total, limit, skip });
});

app.post("/api/:collection", async (req, res) => {
  const documents = collection(req.params.collection);
  const body = req.body;

  const rows: unknown[] = Array.isArray(body) ? body : [body];
  if (rows.length === 0) throw new HttpError(400, "body must contain at least one document");
  rows.forEach((row) => assertDocument(row));

  if (rows.length === 1) {
    const document = rows[0] as Document;
    await documents.insertOne(document);
    res.status(201).json(document);
    return;
  }

  const result = await documents.insertMany(rows as Document[]);
  res.status(201).json({ insertedCount: result.insertedCount, documents: rows });
});

app.get("/api/:collection/:id", async (req, res) => {
  const document = await collection(req.params.collection).findOne({ _id: idFilter(req.params.id) });
  if (!document) throw new HttpError(404, "document not found");
  res.json(document);
});

app.put("/api/:collection/:id", async (req, res) => {
  const documents = collection(req.params.collection);
  assertDocument(req.body, "replacement");

  const { _id: _ignored, ...replacement } = req.body as Document;
  const filter = { _id: idFilter(req.params.id) };

  const result = await documents.replaceOne(filter, replacement);
  if (result.matchedCount === 0) throw new HttpError(404, "document not found");

  res.json(await documents.findOne(filter));
});

app.patch("/api/:collection/:id", async (req, res) => {
  const documents = collection(req.params.collection);
  const updated = await documents.findOneAndUpdate(
    { _id: idFilter(req.params.id) },
    toUpdate(req.body),
    { returnDocument: "after" },
  );

  if (!updated) throw new HttpError(404, "document not found");
  res.json(updated);
});

app.delete("/api/:collection/:id", async (req, res) => {
  const result = await collection(req.params.collection).deleteOne({ _id: idFilter(req.params.id) });
  if (result.deletedCount === 0) throw new HttpError(404, "document not found");
  res.json({ deletedCount: result.deletedCount });
});

app.delete("/api/:collection", async (req, res) => {
  const documents = collection(req.params.collection);

  const filter = jsonObjectParam(stringParam(req.query.filter), "filter");
  const wipe = stringParam(req.query.all) === "true";

  if (Object.keys(filter).length === 0 && !wipe) {
    throw new HttpError(400, "refusing to delete every document: pass a filter or all=true");
  }

  const result = await documents.deleteMany(filter);
  res.json({ deletedCount: result.deletedCount });
});

app.use((req, res) => {
  res.status(404).json({ error: `not found: ${req.method} ${req.originalUrl}` });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = statusForError(err);

  if (status < 500) {
    const message = err instanceof Error ? err.message : "bad request";
    res.status(status).json({ error: message });
    return;
  }

  console.error(err);
  res.status(500).json({ error: "internal server error" });
});

/* -------------------------------------------------------------------- start */

try {
  const db = await connect();
  console.log(`mongodb: ${db.databaseName}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`cannot reach mongodb (${message})`);
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`personal-helper listening on http://localhost:${PORT}`);
  console.log(`node ${process.version} running TypeScript directly (no build step)`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`\n${signal} received, shutting down`);
  server.close();
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

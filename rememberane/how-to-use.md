# How to use the personal-helper API

A generic JSON document API over a local MongoDB. There is no schema, no migrations and no
per-collection code: pick a collection name, send JSON, read it back.

This guide covers running it, every endpoint, query syntax, browser integration, and the
limits you should know about.

---

## 1. Prerequisites

- Node.js **22.18+** (24 recommended). The server runs `.ts` files directly — no build step.
- MongoDB running locally (default `mongodb://127.0.0.1:27017`), or any reachable URI.

```bash
npm install
npm start
```

If mongo cannot be reached the process exits immediately with:

```text
cannot reach mongodb (connect ECONNREFUSED 127.0.0.1:27017)
```

Start mongod (or point `MONGODB_URI` elsewhere) and run it again.

On success:

```text
mongodb: personal_helper
personal-helper listening on http://localhost:3000
node v24.22.0 running TypeScript directly (no build step)
```

`npm run dev` is the same with `--watch`, so edits reload the server.
`npm run typecheck` runs `tsc --noEmit` — the runtime strips types without checking them.

## 2. Configuration

| variable      | default                     | meaning                        |
| ------------- | --------------------------- | ------------------------------ |
| `PORT`        | `3000`                      | HTTP port                      |
| `MONGODB_URI` | `mongodb://127.0.0.1:27017` | Mongo connection string        |
| `MONGODB_DB`  | `personal_helper`           | database used for every request |
| `BODY_LIMIT`  | `10mb`                      | max request body size          |

```bash
PORT=4100 MONGODB_DB=my_app npm start
```

The database is chosen per process, not per request. To use a second database, run a second
instance with a different `MONGODB_DB`.

## 3. Core concepts

- **Collection** = a named bucket of documents. `/api/todos` is the `todos` collection.
  It is created automatically the first time you insert into it.
- **Document** = any JSON object. Fields can be nested, arrays, numbers, booleans, null.
- **`_id`** is the only reserved field:
  - omit it and Mongo generates an ObjectId (returned as a 24-char hex string in JSON),
  - provide it (`"note-1"`, a UUID, …) and it is stored as-is.
  - Once written, `_id` cannot change; PUT/PATCH ignore or reject attempts to set it.
- **Dates** have no JSON representation, so store ISO strings
  (`"2026-10-20T13:00:00.000Z"`). They sort correctly as strings and survive round-trips.
  Sending a JS `Date` from a client is serialized to an ISO string by `JSON.stringify`
  anyway.

Collection names may contain letters, digits, `_`, `-` and `.` (for sub-collections),
must start with a letter or digit, and may not start with `system.`.

## 4. Quickstart: a full lifecycle

```bash
API=http://localhost:3000

# 1. create (the response contains the new _id)
curl -X POST $API/api/todos \
  -H 'content-type: application/json' \
  -d '{"title":"Buy milk","done":false,"tags":["errands"],"createdAt":"2026-10-20T09:00:00.000Z"}'

# 2. paste that _id here
ID=6ad7703abcfdee4645eb561d

# 3. read it back
curl $API/api/todos/$ID

# 4. update one field
curl -X PATCH $API/api/todos/$ID \
  -H 'content-type: application/json' \
  -d '{"done":true}'

# 5. list what is open, newest first
curl -G $API/api/todos \
  --data-urlencode 'filter={"done":false}' \
  --data-urlencode 'sort={"createdAt":-1}'

# 6. delete it
curl -X DELETE $API/api/todos/$ID
```

> `-G` puts `--data-urlencode` values in the query string instead of the body. That matters
> for `GET` and for `DELETE /api/:collection`, which reads its filter from the query string.

## 5. Reading

### List documents

```text
GET /api/:collection?filter=...&sort=...&projection=...&limit=...&skip=...
```

Every query parameter is optional and must be a **JSON-encoded object** (except `limit` and
`skip`, which are integers).

| param        | type          | default  | example                     |
| ------------ | ------------- | -------- | --------------------------- |
| `filter`     | JSON object   | `{}`     | `{"done":false}`            |
| `sort`       | JSON object   | natural  | `{"createdAt":-1,"title":1}`|
| `projection` | JSON object   | all      | `{"_id":0,"title":1}`       |
| `limit`      | 1–1000        | `100`    | `25`                        |
| `skip`       | integer ≥ 0   | `0`      | `50`                        |

```bash
curl -G $API/api/todos \
  --data-urlencode 'filter={"tags":"errands"}' \
  --data-urlencode 'sort={"createdAt":-1}' \
  --data-urlencode 'projection={"_id":0,"title":1,"done":1}' \
  --data-urlencode 'limit=25' \
  --data-urlencode 'skip=0'
```

Response:

```json
{
  "documents": [ { "title": "Buy milk", "done": false } ],
  "count": 1,
  "total": 1,
  "limit": 25,
  "skip": 0
}
```

`count` is the size of this page; `total` is how many matched the filter overall, which is
what you need for pagination UI.

### Filter operators

Most Mongo query operators work, including nested fields and arrays:

| goal                     | filter                                         |
| ------------------------ | ---------------------------------------------- |
| equality                 | `{"done":false}`                               |
| one of several           | `{"status":{"$in":["open","doing"]}}`           |
| comparison               | `{"minutes":{"$gte":5,"$lt":30}}`              |
| exists / missing         | `{"due":{"$exists":true}}`                     |
| array contains value     | `{"tags":"errands"}`                           |
| array contains all       | `{"tags":{"$all":["errands","urgent"]}}`       |
| nested field             | `{"meta.owner.id":"u_123"}`                    |
| case-insensitive match   | `{"title":{"$regex":"milk","$options":"i"}}`   |
| OR / AND                 | `{"$or":[{"done":true},{"due":{"$lt":"2026-11-01"}}]}` |
| null or missing          | `{"note":null}`                                |

Blocked on purpose (server-side JavaScript): `$where`, `$function`, `$accumulator`.
A request using them returns `400`.

### Read one

```text
GET /api/:collection/:id
```

`:id` matches either the ObjectId hex string or a string `_id` you supplied, so a document
created with `"_id":"note-1"` is reachable both ways:

```bash
curl $API/api/notes/note-1
```

A miss returns `404 {"error":"document not found"}`.

### List collections

```bash
curl $API/api
# { "database": "personal_helper", "collections": ["todos", "notes"] }
```

System collections are hidden.

## 6. Writing

### Insert one

```bash
curl -X POST $API/api/todos \
  -H 'content-type: application/json' \
  -d '{"title":"Buy milk","done":false}'
```

Returns `201` with the stored document (including `_id`). Supplying `_id` is allowed:

```bash
curl -X POST $API/api/settings \
  -H 'content-type: application/json' \
  -d '{"_id":"theme","value":{}}'
```

### Bulk insert

Send an array. Returns `201` with `{ insertedCount, documents }`, where every document has
its generated `_id`.

```bash
curl -X POST $API/api/todos \
  -H 'content-type: application/json' \
  -d '[{"title":"A"},{"title":"B"}]'
```

### Replace (PUT)

The body becomes the entire document. Missing fields are removed; `_id` in the body is
ignored, the existing one is kept.

```bash
curl -X PUT $API/api/todos/$ID \
  -H 'content-type: application/json' \
  -d '{"title":"Buy oat milk","done":true}'
```

### Update (PATCH)

Two styles:

```bash
# plain fields -> shorthand for $set (other fields untouched)
curl -X PATCH $API/api/todos/$ID \
  -H 'content-type: application/json' \
  -d '{"done":true,"meta.seenAt":"2026-10-20T10:00:00.000Z"}'
```

```bash
# mongo update operators -> applied verbatim
curl -X PATCH $API/api/todos/$ID \
  -H 'content-type: application/json' \
  -d '{"$inc":{"visits":1},"$push":{"tags":"later"}}'
```

Useful operators: `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$push`, `$addToSet`,
`$pull`, `$rename`. Mixing operators and plain fields in one request is a `400`; send a
single style.

Responses for PUT/PATCH return the document **after** the change. A missing document is
`404`.

> There is no upsert. `PUT`/`PATCH` only modify existing documents; use a write endpoint
> with an explicit `_id` when you want create-or-replace behaviour.

## 7. Deleting

```bash
# one document
curl -X DELETE $API/api/todos/$ID
# { "deletedCount": 1 }
```

```bash
# many, by filter
curl -G -X DELETE $API/api/todos \
  --data-urlencode 'filter={"done":true}'
# { "deletedCount": 7 }
```

A missing filter — or an empty `{}` — is refused to prevent accidents:

```json
{ "error": "refusing to delete every document: pass a filter or all=true" }
```

To really wipe a collection you must say so:

```bash
curl -G -X DELETE $API/api/todos --data-urlencode 'all=true'
```

This deletes documents, not the collection itself; it stays in `/api` until dropped in
mongo.

## 8. Calling it from a web app

CORS is open (`*`) for every origin, and `OPTIONS` preflights are answered, so a local dev
server on any port can call it directly. Writes must send `content-type: application/json`.

```js
const API = "http://localhost:3000";

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const todos = {
  list: (filter = {}) =>
    request(
      "/api/todos?" +
        new URLSearchParams({
          filter: JSON.stringify(filter),
          sort: JSON.stringify({ createdAt: -1 }),
        }),
    ).then((r) => r.documents),

  create: (todo) =>
    request("/api/todos", { method: "POST", body: JSON.stringify(todo) }),

  update: (id, patch) =>
    request(`/api/todos/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),

  remove: (id) => request(`/api/todos/${id}`, { method: "DELETE" }),
};
```

Usage:

```js
await todos.create({ title: "Buy milk", done: false, createdAt: new Date().toISOString() });
const open = await todos.list({ done: false });
```

Always build the query string with `URLSearchParams` (or `encodeURIComponent`) — a raw
`{"done":false}` in the URL is not valid and will be rejected as bad JSON.

## 9. Errors

Every error is JSON: `{ "error": "message" }`.

| status | when                                                              |
| ------ | ----------------------------------------------------------------- |
| 400    | bad JSON body, bad `filter`/`sort`/`projection`, bad collection name, blocked operator, mixed PATCH styles, empty update |
| 403    | mongo authorization failure                                       |
| 404    | unknown route, unknown document                                   |
| 409    | duplicate `_id` or unique index                                   |
| 413    | body over `BODY_LIMIT`                                            |
| 500    | unexpected server error (stack is logged, not returned)           |
| 503    | `/health` when mongo is unreachable                               |

Mongo's `code` field is mapped to the status; the message is passed through, e.g.
`409 duplicate key error ...`.

## 10. Guard rails and limits

- **No auth.** `app.listen(PORT)` listens on all interfaces, so anyone who can reach the
  port can read and delete everything. That is why it is meant for local use — do not port
  forward it or run it on a public host.
- **No bulk update.** PATCH is per document. Loop client-side, or use mongosh for a
  one-off mass update.
- **No aggregation / transactions / joins.** Point a mongo client at the database if you
  need those.
- **No indexes are created.** A generic API cannot know your query patterns. For large
  collections add indexes yourself, e.g. in mongosh:
  `db.todos.createIndex({ done: 1, createdAt: -1 })`.
- **Response size.** Default page is 100 documents, hard max 1000; request bodies cap at
  10 MB. Raise `BODY_LIMIT` if you store bigger blobs.
- **One database per process** (`MONGODB_DB`), picked at startup.

## 11. Troubleshooting

| symptom | cause / fix |
| --- | --- |
| `EADDRINUSE :3000` | another instance is running: `lsof -nP -iTCP:3000 -sTCP:LISTEN`, kill it, or use `PORT=3001`. |
| `cannot reach mongodb (ECONNREFUSED)` | mongod is not running, or `MONGODB_URI` is wrong. |
| 400 `Expected property name or '}' in JSON at position 1` | malformed body. With curl wrap the JSON in single quotes and use double quotes inside. |
| `` `filter` must be valid JSON `` | the filter was not URL-encoded. Use `curl -G --data-urlencode 'filter={...}'` or `URLSearchParams` in JS. |
| `document not found` after insert | you used the wrong `_id`; the response of `POST` contains the real one. |
| `409 duplicate key` | that `_id` (or unique index value) already exists. |
| Types/imports fail at runtime but `tsc` is fine | you used non-erasable syntax (`enum`, parameter properties) or a type imported without `import type`. |

## 12. Where things live

| file | purpose |
| --- | --- |
| `rememberane/index.ts` | express app, routes, query parsing, error mapping |
| `rememberane/db.ts` | mongo connection, collection validation, `_id` lookup, operator guard |
| `rememberane/errors.ts` | `HttpError` |
| `rememberane/how-to-use.md` | this guide |
| `tsconfig.json` | typecheck only (`noEmit`, `erasableSyntaxOnly`) |

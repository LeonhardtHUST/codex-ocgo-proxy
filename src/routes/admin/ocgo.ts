import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { MAX_OCGO_CREDENTIALS, OCGoCredentialInputSchema, type OCGoKeyStore } from "../../auth/ocgo-key-store.js";
import type { OCGoPool } from "../../auth/ocgo-pool.js";
import { OCGoError, OCGoUpstream } from "../../proxy/ocgo-upstream.js";
import type { AppConfig } from "../../config-schema.js";
import { isOCGoModelId, OCGO_MODEL_PREFIX } from "../../ocgo-config.js";
import { readOCGoTokens } from "../../auth/ocgo-usage.js";
import { isRecord } from "../../translation/shared-utils.js";
import { z } from "zod";
import { safeEqual } from "../../auth/safe-equal.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";

const path = "/admin/opencode/keys";
const createSchema = OCGoCredentialInputSchema.extend({ enabled: OCGoCredentialInputSchema.shape.enabled.default(true) });
const updateSchema = OCGoCredentialInputSchema.partial();
const verifySchema = z.object({ model: z.string().refine(isOCGoModelId) }).strict();

interface Options {
  store: Pick<OCGoKeyStore, "readCredentials" | "replaceCredentials">;
  pool: Pick<OCGoPool, "snapshot" | "acquire">;
  config: AppConfig["ocgo"];
  getMasterKey: () => string | null;
}

export function createOCGoAdminRoutes({ store, pool, config, getMasterKey }: Options): Hono {
  const app = new Hono();
  const reject = (c: Context) => c.json({ error: "Dashboard login or master API key required" }, 401, { "X-Dashboard-Auth": "required" });
  app.use(`${path}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const provided = /^Bearer ([^\s]+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const master = getMasterKey();
    if (provided && master && safeEqual(provided, master)) return next();

    const session = parseSessionCookie(c.req.header("cookie"));
    if (!session || !validateSession(session)) return reject(c);
    if (c.req.method !== "GET" && ![undefined, "same-origin", "none"].includes(c.req.header("Sec-Fetch-Site"))) {
      return c.json({ error: "Cross-origin OCGo management is not allowed" }, 403);
    }
    return next();
  });
  const limit = bodyLimit({ maxSize: 32 * 1024, onError: (c) => c.json({ error: "OCGo request body too large" }, 413) });
  const readJson = (c: Context) => /^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")
    ? c.req.json<unknown>().catch(() => null) : null;
  const storeError = (c: Context) => c.json({ error: "OCGo credential store is unavailable" }, 503);

  app.get(path, (c) => {
    try { return c.json({ enabled: true, ...pool.snapshot() }); } catch { return storeError(c); }
  });

  app.post(path, limit, async (c) => {
    const parsed = createSchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Invalid OCGo credential fields" }, 400);
    const id = randomUUID();
    try {
      const entries = store.readCredentials();
      if (entries.length >= MAX_OCGO_CREDENTIALS) return c.json({ error: "OCGo credential pool is full" }, 409);
      if (entries.some((entry) => entry.apiKey === parsed.data.apiKey)) return c.json({ error: "OCGo credential already exists" }, 409);
      store.replaceCredentials([...entries, { ...parsed.data, id }]);
      pool.snapshot(); // Reconcile in-memory health/affinity before the next mutation.
    } catch { return storeError(c); }
    return c.json({ id }, 201);
  });

  app.patch(`${path}/:id`, limit, async (c) => {
    const parsed = updateSchema.safeParse(await readJson(c));
    if (!parsed.success || Object.keys(parsed.data).length === 0) return c.json({ error: "Invalid OCGo credential fields" }, 400);
    const id = c.req.param("id");
    try {
      const entries = store.readCredentials();
      const entry = entries.find((item) => item.id === id);
      if (!entry) return c.json({ error: "OCGo credential not found" }, 404);
      const patch = parsed.data;
      if (patch.apiKey && entries.some((item) => item.id !== id && item.apiKey === patch.apiKey)) {
        return c.json({ error: "OCGo credential already exists" }, 409);
      }
      const next = { ...entry, ...patch };
      if (next.apiKey !== entry.apiKey && patch.quotaGroup === undefined) next.quotaGroup = null;
      store.replaceCredentials(entries.map((item) => item.id === id ? next : item));
      pool.snapshot();
    } catch { return storeError(c); }
    return c.json({ id });
  });

  app.delete(`${path}/:id`, (c) => {
    try {
      const entries = store.readCredentials();
      const remaining = entries.filter(({ id }) => id !== c.req.param("id"));
      if (remaining.length === entries.length) return c.json({ error: "OCGo credential not found" }, 404);
      store.replaceCredentials(remaining);
      pool.snapshot();
    } catch { return storeError(c); }
    return c.body(null, 204);
  });
  app.post(`${path}/:id/verify`, limit, async (c) => {
    
    const parsed = verifySchema.safeParse(await readJson(c));
    if (!parsed.success) return c.json({ error: "Select a configured OpenCode model" }, 400);
    const { model } = parsed.data;
    const id = c.req.param("id");
    let selection;
    try {
      const entry = store.readCredentials().find((item) => item.id === id);
      if (!entry) return c.json({ error: "OCGo credential not found" }, 404);
      if (!entry.models.includes(model)) return c.json({ error: "Model not assigned to this OCGo credential" }, 400);
      selection = pool.acquire(model, undefined, undefined, id);
    } catch { return storeError(c); }
    if (selection.kind === "backoff") {
      return c.json({ error: "OCGo credential is cooling down" }, 429, { "Retry-After": String(selection.retryAfterSeconds) });
    }
    if (selection.kind !== "selected") return c.json({ error: "OCGo credential is disabled, unavailable or busy" }, 409);
    const { lease } = selection;
    const abort = new AbortController();
    const signal = AbortSignal.any([c.req.raw.signal, abort.signal]);
    let settle: ReturnType<typeof lease.beginAttempt> | undefined;
    try {
      const upstream = new OCGoUpstream(config.base_url, lease.apiKey, Math.min(15, config.timeout_seconds));
      const response = await upstream.createResponse({
        model: `${OCGO_MODEL_PREFIX}${model}`,
        input: [{ role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }],
        stream: true, store: false,
      }, signal, () => { settle = lease.beginAttempt(); });
      for await (const event of upstream.parseStream(response)) {
        if (signal.aborted) break;
        if (event.event === "response.completed" && isRecord(event.data) && isRecord(event.data.response)) {
          settle?.("succeeded", readOCGoTokens(event.data.response));
          return c.json({ ok: true });
        }
      }
      return c.json({ error: "OCGo verification did not complete" }, 502);
    } catch (e) {
      if (e instanceof OCGoError && !signal.aborted) {
        lease.reportFailure(e.failure, e.retryAfterSeconds);
        if (e.retryAfterSeconds !== undefined) c.header("Retry-After", String(e.retryAfterSeconds));
        return c.json({ error: "OCGo verification failed", code: e.code }, e.status === 429 ? 429 : e.status === 504 ? 504 : 502);
      }
      return c.json({ error: "OCGo verification failed" }, 502);
    } finally {
      settle?.(signal.aborted ? "cancelled" : "failed");
      abort.abort();
      lease.release();
    }
  });
  return app;
}

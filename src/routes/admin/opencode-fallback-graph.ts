/**
 * Admin API for the fallback graph.
 *
 * Mirrors the OpenCode admin auth model: master key bearer or a dashboard session; writes
 * additionally require a same-origin hint so a cross-site form cannot rewrite the graph.
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { safeEqual } from "../../auth/safe-equal.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";
import { FallbackGraphSchema } from "../../opencode/fallback-graph/model.js";
import { validateGraph } from "../../opencode/fallback-graph/validate.js";
import type { FallbackGraphStore } from "../../opencode/fallback-graph/store.js";

const PATH = "/admin/opencode/fallback-graph";
const BODY_LIMIT_BYTES = 256 * 1024;

export interface OpenCodeFallbackGraphOptions {
  store: Pick<FallbackGraphStore, "read" | "save" | "status" | "invalidate">;
  getMasterKey: () => string | null;
}

export function createOpenCodeFallbackGraphRoutes({ store, getMasterKey }: OpenCodeFallbackGraphOptions): Hono {
  const app = new Hono();
  const reject = (c: Context) => c.json({ error: "Dashboard login or master API key required" }, 401, { "X-Dashboard-Auth": "required" });

  app.use(`${PATH}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const provided = /^Bearer ([^\s]+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const master = getMasterKey();
    if (provided && master && safeEqual(provided, master)) return next();

    const session = parseSessionCookie(c.req.header("cookie"));
    if (!session || !validateSession(session)) return reject(c);
    if (c.req.method !== "GET" && ![undefined, "same-origin", "none"].includes(c.req.header("Sec-Fetch-Site"))) {
      return c.json({ error: "Cross-origin fallback graph edits are not allowed" }, 403);
    }
    return next();
  });

  const limit = bodyLimit({
    maxSize: BODY_LIMIT_BYTES,
    onError: (c) => c.json({ error: "Fallback graph payload too large" }, 413),
  });
  const readJson = (c: Context) => (/^application\/json(?:\s*;|$)/i.test(c.req.header("Content-Type") ?? "")
    ? c.req.json<unknown>().catch(() => null)
    : null);

  app.get(PATH, (c) => {
    if (!getMasterKey() && !parseSessionCookie(c.req.header("cookie"))) return reject(c);
    return c.json({ graph: store.read(), status: store.status() });
  });

  app.put(PATH, limit, async (c) => {
    const body = await readJson(c);
    if (body === null) return c.json({ ok: false, errors: [{ path: "(body)", message: "JSON body required" }] }, 400);
    const result = store.save(body);
    if (!result.ok) return c.json({ ok: false, errors: result.errors }, 400);
    return c.json({ ok: true, graph: result.graph, status: store.status() });
  });

  app.post(`${PATH}/validate`, limit, async (c) => {
    const body = await readJson(c);
    // Empty body validates the stored graph; a body validates the candidate document.
    if (body === null || (typeof body === "object" && body !== null && Object.keys(body as Record<string, unknown>).length === 0)) {
      const result = validateGraph(store.read());
      return c.json({ ok: result.ok, errors: result.errors, source: "stored" });
    }
    const parsed = FallbackGraphSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({
        ok: false,
        source: "body",
        errors: parsed.error.issues.map((issue) => ({ path: issue.path.join(".") || "(root)", message: issue.message })),
      });
    }
    const result = validateGraph(parsed.data);
    return c.json({ ok: result.ok, errors: result.errors, source: "body" });
  });

  return app;
}

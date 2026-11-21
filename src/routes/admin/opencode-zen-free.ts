/**
 * Admin API for the zen-free aggregated pool.
 *
 * Read-only snapshot plus an explicit reset. Reset is the only way to clear the channel
 * breaker: free-tier limits are decided by the caller's origin, so a success on one key
 * must not reopen the channel for everyone.
 */

import { Hono, type Context } from "hono";
import { safeEqual } from "../../auth/safe-equal.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";
import type { OpenCodeConfig } from "../../opencode/config.js";
import type { ZenFreePool } from "../../opencode/zen-free-pool.js";

const PATH = "/admin/opencode/zen-free";

export interface OpenCodeZenFreeOptions {
  /** Null when the switch is off; the route then reports `enabled: false`. */
  pool: ZenFreePool | null;
  config: OpenCodeConfig;
  getMasterKey: () => string | null;
}

export function createOpenCodeZenFreeRoutes({ pool, config, getMasterKey }: OpenCodeZenFreeOptions): Hono {
  const app = new Hono();
  const reject = (c: Context) => c.json({ error: "Dashboard login or master API key required" }, 401, { "X-Dashboard-Auth": "required" });

  app.use(`${PATH}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const provided = /^Bearer ([^\s]+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const master = getMasterKey();
    if (provided && master && safeEqual(provided, master)) return next();
    const session = parseSessionCookie(c.req.header("cookie"));
    if (!session || !validateSession(session)) return reject(c);
    return next();
  });

  app.get(PATH, (c) => {
    const enabled = config.enabled && config.upstreams.zen_free.enabled;
    return c.json({
      enabled,
      pool_all_keys: config.upstreams.zen_free.pool_all_keys,
      snapshot: enabled && pool ? pool.snapshot() : null,
    });
  });

  app.post(`${PATH}/reset`, async (c) => {
    if (!pool) return c.json({ ok: false, error: "zen-free pool is disabled" }, 409);
    const body: unknown = await c.req.json().catch(() => ({}));
    const scope = (body && typeof body === "object" && (body as { scope?: unknown }).scope) || "breaker";
    if (scope === "all") {
      pool.reset();
      return c.json({ ok: true, scope: "all" });
    }
    if (scope !== "breaker") return c.json({ ok: false, error: "scope must be breaker or all" }, 400);
    pool.resetBreaker();
    return c.json({ ok: true, scope: "breaker", snapshot: pool.snapshot() });
  });

  return app;
}

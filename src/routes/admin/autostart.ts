/**
 * Admin API for autostart (Windows).
 *
 * Nothing is registered unless this endpoint is called: the server never enables autostart
 * on its own, and the elevated helper is only spawned from an explicit user action.
 */

import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { safeEqual } from "../../auth/safe-equal.js";
import { validateSession } from "../../auth/dashboard-session.js";
import { parseSessionCookie } from "../../utils/parse-cookie.js";
import { getRootDir } from "../../paths.js";
import {
  AUTOSTART_ENTRY_NAME,
  buildElevatedHelperCommand,
  disableAutostart,
  enableAutostart,
  getAutostartStatus,
  type AutostartDependencies,
  type AutostartSettings,
} from "../../autostart/index.js";

const PATH = "/admin/autostart";

const applySchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["registry", "task", "startup"]).optional(),
  scope: z.enum(["user", "machine"]).optional(),
  runAsAdmin: z.boolean().optional(),
  delaySeconds: z.number().int().min(0).max(600).optional(),
}).strict();

export interface AutostartRouteOptions {
  getSettings: () => AutostartSettings;
  getMasterKey: () => string | null;
  /** Test seam for registration and detection. */
  deps?: AutostartDependencies;
  /** Test seam for the elevated spawn. */
  spawnImpl?: typeof spawn;
  helperPath?: string;
}

export function createAutostartRoutes(options: AutostartRouteOptions): Hono {
  const app = new Hono();
  const reject = (c: Context) => c.json({ error: "Dashboard login or master API key required" }, 401, { "X-Dashboard-Auth": "required" });

  app.use(`${PATH}/*`, async (c, next) => {
    c.header("Cache-Control", "no-store");
    const provided = /^Bearer ([^\s]+)$/i.exec(c.req.header("Authorization") ?? "")?.[1];
    const master = options.getMasterKey();
    if (provided && master && safeEqual(provided, master)) return next();
    const session = parseSessionCookie(c.req.header("cookie"));
    if (!session || !validateSession(session)) return reject(c);
    if (c.req.method !== "GET" && ![undefined, "same-origin", "none"].includes(c.req.header("Sec-Fetch-Site"))) {
      return c.json({ error: "Cross-origin autostart changes are not allowed" }, 403);
    }
    return next();
  });

  const withDefaults = (patch: Partial<AutostartSettings>): AutostartSettings => ({ ...options.getSettings(), ...patch });

  app.get(PATH, async (c) => {
    const settings = options.getSettings();
    const status = await getAutostartStatus(settings, options.deps);
    return c.json({ entry: AUTOSTART_ENTRY_NAME, settings, status });
  });

  app.post(PATH, async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const parsed = applySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, error: "invalid body", issues: parsed.error.issues }, 400);
    }
    const settings = withDefaults({
      ...(parsed.data.mode ? { mode: parsed.data.mode } : {}),
      ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
      ...(parsed.data.runAsAdmin !== undefined ? { runAsAdmin: parsed.data.runAsAdmin } : {}),
      ...(parsed.data.delaySeconds !== undefined ? { delaySeconds: parsed.data.delaySeconds } : {}),
    });

    const result = parsed.data.enabled
      ? await enableAutostart(settings, options.deps)
      : await disableAutostart(settings, options.deps);

    if (!result.ok && result.elevationRequired) {
      return c.json({
        ok: false,
        elevationRequired: true,
        settings,
        status: result.status,
        error: result.error ?? "administrator rights are required",
        hint: `POST ${PATH}/elevate to retry through one UAC prompt, or run the generated command as administrator`,
      }, 409);
    }
    if (!result.ok) return c.json({ ok: false, settings, status: result.status, error: result.error }, 500);
    return c.json({ ok: true, settings, status: result.status });
  });

  // One explicit UAC prompt: spawn the helper through Start-Process -Verb RunAs.
  app.post(`${PATH}/elevate`, async (c) => {
    if (process.platform !== "win32") return c.json({ ok: false, error: "elevation is only supported on Windows" }, 400);
    const body: unknown = await c.req.json().catch(() => ({}));
    const enabled = typeof (body as { enabled?: unknown })?.enabled === "boolean" ? (body as { enabled: boolean }).enabled : true;
    const settings = options.getSettings();
    const helper = options.helperPath ?? resolve(getRootDir(), "scripts", "autostart-helper.mjs");
    const status = await getAutostartStatus(settings, options.deps);
    const command = status.command;

    const args = buildElevatedHelperCommand(helper, settings, command, enabled ? "apply" : "remove");

    try {
      const spawnImpl = options.spawnImpl ?? spawn;
      const child = spawnImpl("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: false });
      child.unref?.();
      return c.json({ ok: true, started: true, action: enabled ? "apply" : "remove" });
    } catch (error) {
      return c.json({ ok: false, error: (error as Error).message }, 500);
    }
  });

  return app;
}

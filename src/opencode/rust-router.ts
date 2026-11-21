/**
 * Lifecycle manager for the in-repo Rust router (`native/ocx-router`).
 *
 * Rust only executes what Node decides, so this module owns spawning, readiness, the
 * catalogue push, and — critically — the explicit degradation path: when the binary is
 * missing or fails to become healthy, the router state becomes `degraded` and callers
 * fall back to the TypeScript adapter. Nothing silently pretends to be routed by Rust.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OpenCodeCatalog } from "./catalog.js";
import type { OpenCodeRustRoutingConfig } from "./config.js";

export type RustRouterState = "disabled" | "starting" | "ready" | "degraded";

export interface RustRouterStatus {
  state: RustRouterState;
  port: number;
  baseUrl: string;
  pid?: number;
  binaryPath?: string;
  lastError?: string;
  catalogModels?: number;
}

export interface RustRouterOptions {
  config: OpenCodeRustRoutingConfig;
  /** Logical upstream roots, forwarded as environment so Rust stays catalog-free. */
  upstreamRoots?: { go: string; zen: string };
  /** Injectable for tests. */
  spawnImpl?: typeof spawn;
  fetchImpl?: typeof fetch;
  /** Override binary discovery (tests). */
  resolveBinary?: (explicitPath?: string) => string | undefined;
  /** Health poll interval. */
  pollIntervalMs?: number;
}

const BINARY_NAME = process.platform === "win32" ? "ocx-router.exe" : "ocx-router";

/** Process-wide router instance, set by the app bootstrap. */
let activeRouter: RustRouterProcess | null = null;

/** Install the router the dispatch layer should consult. */
export function setActiveRustRouter(router: RustRouterProcess | null): void {
  activeRouter = router;
}

/** Currently installed router, if any. */
export function getActiveRustRouter(): RustRouterProcess | null {
  return activeRouter;
}

/**
 * Candidate locations for the binary, most specific first. The dev build path is
 * derived from this module's location so it works from `dist/` and from `tsx`.
 */
export function resolveRustRouterBinary(explicitPath?: string): string | undefined {
  if (explicitPath && existsSync(explicitPath)) return resolve(explicitPath);
  const here = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(here, "..", "..");
  const candidates = [
    join(repoRoot, "native", "ocx-router", "target", "release", BINARY_NAME),
    join(repoRoot, "native", "ocx-router", "target", "debug", BINARY_NAME),
    join(dirname(process.execPath), BINARY_NAME),
    join(process.cwd(), "native", "ocx-router", "target", "release", BINARY_NAME),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export class RustRouterProcess {
  readonly #options: RustRouterOptions;
  #state: RustRouterState;
  #child: ChildProcessWithoutNullStreams | null = null;
  #lastError: string | undefined;
  #binaryPath: string | undefined;
  #catalogModels: number | undefined;
  #stopping = false;

  constructor(options: RustRouterOptions) {
    this.#options = options;
    this.#state = options.config.enabled ? "disabled" : "disabled";
  }

  get state(): RustRouterState {
    return this.#state;
  }

  /** Base URL the adapters should target; only meaningful when state is `ready`. */
  get baseUrl(): string {
    return this.#options.config.base_url;
  }

  /** True only when a request may be routed through Rust right now. */
  get isReady(): boolean {
    return this.#state === "ready";
  }

  status(): RustRouterStatus {
    return {
      state: this.#state,
      port: this.#options.config.port,
      baseUrl: this.#options.config.base_url,
      ...(this.#child?.pid ? { pid: this.#child.pid } : {}),
      ...(this.#binaryPath ? { binaryPath: this.#binaryPath } : {}),
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      ...(this.#catalogModels !== undefined ? { catalogModels: this.#catalogModels } : {}),
    };
  }

  /**
   * Spawn the binary and wait for `/health`.
   * Returns false (and marks `degraded`) instead of throwing when unavailable.
   */
  async start(): Promise<boolean> {
    if (!this.#options.config.enabled) {
      this.#state = "disabled";
      return false;
    }
    if (this.#state === "ready") return true;

    const binary = (this.#options.resolveBinary ?? resolveRustRouterBinary)(this.#options.config.binary_path);
    if (!binary) {
      this.#lastError = "ocx-router binary not found (build native/ocx-router or set binary_path)";
      this.#state = "degraded";
      return false;
    }
    this.#binaryPath = binary;
    this.#state = "starting";
    this.#stopping = false;

    const spawnImpl = this.#options.spawnImpl ?? spawn;
    try {
      const child = spawnImpl(binary, ["--port", String(this.#options.config.port)], {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          OCX_ROUTER_PORT: String(this.#options.config.port),
          ...(this.#options.upstreamRoots
            ? {
                OCX_UPSTREAM_GO: this.#options.upstreamRoots.go,
                OCX_UPSTREAM_ZEN: this.#options.upstreamRoots.zen,
              }
            : {}),
        },
      }) as unknown as ChildProcessWithoutNullStreams;
      this.#child = child;
      child.on("exit", (code, signal) => {
        if (this.#stopping) return;
        this.#state = "degraded";
        this.#lastError = `ocx-router exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
        this.#child = null;
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text.length > 0) this.#lastError = text.slice(0, 300);
      });
    } catch (error) {
      this.#lastError = `spawn failed: ${(error as Error).message}`;
      this.#state = "degraded";
      return false;
    }

    const healthy = await this.#waitForHealth();
    if (!healthy) {
      this.#state = "degraded";
      await this.#terminate();
      return false;
    }
    this.#state = "ready";
    this.#lastError = undefined;
    return true;
  }

  /** Ask the service to exit and clear state. Safe to call repeatedly. */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#state = "disabled";
    await this.#terminate();
  }

  /** Kill the child without touching state (used by the failure path). */
  async #terminate(): Promise<void> {
    const child = this.#child;
    this.#child = null;
    if (!child) return;
    try {
      child.kill();
    } catch {
      // already gone
    }
  }

  /** Push the model catalogue so `/v1/models` inside Rust matches Node's view. */
  async pushCatalog(catalog: Pick<OpenCodeCatalog, "list">): Promise<boolean> {
    if (this.#state !== "ready") return false;
    const doFetch = this.#options.fetchImpl ?? fetch;
    try {
      const payload = {
        version: String(Date.now()),
        models: catalog.list().map((entry) => ({
          id: entry.id,
          upstream: entry.upstream,
          protocol: entry.protocols[0],
          context_window: entry.contextWindow,
          free: entry.free,
        })),
      };
      const response = await doFetch(`${this.#options.config.base_url.replace(/\/v1$/, "")}/internal/catalog`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        this.#lastError = `catalog push failed: HTTP ${response.status}`;
        return false;
      }
      this.#catalogModels = payload.models.length;
      return true;
    } catch (error) {
      this.#lastError = `catalog push failed: ${(error as Error).message}`;
      return false;
    }
  }

  async health(): Promise<{ ok: boolean; models?: number }> {
    const doFetch = this.#options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(`${this.#options.config.base_url.replace(/\/v1$/, "")}/health`, {
        method: "GET",
      });
      if (!response.ok) return { ok: false };
      const body = await response.json() as { models?: number };
      return { ok: true, ...(typeof body.models === "number" ? { models: body.models } : {}) };
    } catch {
      return { ok: false };
    }
  }

  async #waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + this.#options.config.startup_timeout_ms;
    const interval = this.#options.pollIntervalMs ?? 200;
    while (Date.now() < deadline) {
      if (this.#child === null && !this.#stopping) return false;
      const health = await this.health();
      if (health.ok) return true;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, interval));
    }
    this.#lastError ??= `ocx-router did not become healthy within ${this.#options.config.startup_timeout_ms}ms`;
    return false;
  }
}

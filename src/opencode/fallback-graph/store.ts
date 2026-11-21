/**
 * Fallback graph persistence.
 *
 * The graph lives in the data directory (not in yaml) because the editor writes it
 * through the admin API. Writes are atomic and validated first: an invalid graph never
 * replaces a working one.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "../../paths.js";
import { FallbackGraphSchema, emptyFallbackGraph, type FallbackGraph } from "./model.js";
import { validateGraph, type GraphValidationResult } from "./validate.js";

export const FALLBACK_GRAPH_FILE = "opencode-fallback-graph.json";

export type SaveResult =
  | { ok: true; graph: FallbackGraph }
  | { ok: false; errors: GraphValidationResult["errors"] };

export interface FallbackGraphStatus {
  filePath: string;
  loaded: boolean;
  lastError?: string;
  nodes: number;
  edges: number;
  entrypoints: number;
}

export class FallbackGraphStore {
  readonly #file: string;
  #cached: FallbackGraph | null = null;
  #lastError: string | undefined;

  constructor(filePath?: string) {
    this.#file = filePath ?? join(getDataDir(), FALLBACK_GRAPH_FILE);
  }

  get filePath(): string {
    return this.#file;
  }

  /** Current graph. Missing or unreadable files yield an empty graph, never a throw. */
  read(): FallbackGraph {
    if (this.#cached) return this.#cached;
    let raw: string;
    try {
      raw = readFileSync(this.#file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") this.#lastError = `unreadable: ${(error as Error).message}`;
      this.#cached = emptyFallbackGraph();
      return this.#cached;
    }
    try {
      const parsed = FallbackGraphSchema.parse(JSON.parse(raw));
      const result = validateGraph(parsed);
      if (!result.ok) {
        this.#lastError = `invalid: ${result.errors.map((item) => `${item.path}: ${item.message}`).join("; ")}`;
        this.#cached = emptyFallbackGraph();
        return this.#cached;
      }
      this.#cached = parsed;
      return parsed;
    } catch (error) {
      this.#lastError = `parse: ${(error as Error).message}`;
      this.#cached = emptyFallbackGraph();
      return this.#cached;
    }
  }

  /** Validate then persist atomically (write temp, rename). */
  save(input: unknown): SaveResult {
    const parsed = FallbackGraphSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join(".") || "(root)",
          message: issue.message,
        })),
      };
    }
    const result = validateGraph(parsed.data);
    if (!result.ok) return { ok: false, errors: result.errors };

    const tmp = `${this.#file}.tmp`;
    try {
      mkdirSync(dirname(this.#file), { recursive: true });
      writeFileSync(tmp, `${JSON.stringify(parsed.data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, this.#file);
    } catch (error) {
      this.#lastError = `write: ${(error as Error).message}`;
      return { ok: false, errors: [{ path: "(io)", message: "failed to persist fallback graph" }] };
    }
    this.#cached = parsed.data;
    this.#lastError = undefined;
    return { ok: true, graph: parsed.data };
  }

  /** Drop the cache so the next read hits disk (used after external edits). */
  invalidate(): void {
    this.#cached = null;
  }

  status(): FallbackGraphStatus {
    const graph = this.read();
    return {
      filePath: this.#file,
      loaded: this.#cached !== null,
      ...(this.#lastError ? { lastError: this.#lastError } : {}),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      entrypoints: Object.keys(graph.entrypoints).length,
    };
  }
}

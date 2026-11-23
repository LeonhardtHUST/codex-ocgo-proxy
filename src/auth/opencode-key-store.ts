import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isOpenCodeKey, isOpenCodeModelId } from "../opencode-legacy-config.js";
import { getDataDir } from "../paths.js";

export const OpenCodeCredentialInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  apiKey: z.string().refine(isOpenCodeKey),
  models: z.array(z.string().refine(isOpenCodeModelId)).min(1).max(200),
  enabled: z.boolean(),
  /** Administrator-confirmed quota owner; missing/null is unknown, not independent. */
  quotaGroup: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).nullable().optional(),
}).strict();
const credentialSchema = OpenCodeCredentialInputSchema.extend({ id: z.string().uuid() });
export const MAX_OPENCODE_CREDENTIALS = 100;
const fileSchema = z.object({ version: z.literal(1), credentials: z.array(credentialSchema).max(MAX_OPENCODE_CREDENTIALS) }).strict();

/** Server-internal credential. Never serialize it into a response or a log. */
export type OpenCodeCredential = z.infer<typeof credentialSchema>;

function defaultStoreFile(): string {
  return join(getDataDir(), "opencode-keys.json");
}

function parseStore(raw: unknown): OpenCodeCredential[] {
  const result = fileSchema.safeParse(raw);
  if (!result.success) throw new Error("Invalid OpenCode credential store");
  const { credentials } = result.data;
  if (new Set(credentials.map((entry) => entry.id)).size !== credentials.length ||
      new Set(credentials.map((entry) => entry.apiKey)).size !== credentials.length) {
    throw new Error("Duplicate OpenCode credentials");
  }
  for (const entry of credentials) entry.models = [...new Set(entry.models)];
  return credentials;
}

/** Separate from Custom and from exportable app settings. File access relies on the app data directory ACL. */
export class OpenCodeKeyStore {
  readonly #file: string;

  constructor(file?: string) {
    this.#file = file ?? defaultStoreFile();
    // Pre-rename installations stored the same data under `ocgo-keys.json`. Move it once
    // instead of leaving credentials behind on an upgrade.
    if (!file && !existsSync(this.#file)) {
      const legacy = join(getDataDir(), "ocgo-keys.json");
      if (existsSync(legacy)) {
        try {
          renameSync(legacy, this.#file);
        } catch { /* keep going: readCredentials reports a readable error if it matters */ }
      }
    }
  }

  readCredentials(): OpenCodeCredential[] {
    let raw: string;
    try {
      raw = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Cannot read OpenCode credential store");
    }
    // JSON.parse errors can include a snippet of the secret-bearing file.
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error("Invalid OpenCode credential store"); }
    return parseStore(data);
  }

  replaceCredentials(credentials: readonly OpenCodeCredential[]): void {
    const entries = parseStore({ version: 1, credentials });
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify({ version: 1, credentials: entries })}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.#file);
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* keep the original file intact */ }
      throw new Error("Cannot save OpenCode credential store");
    }
  }
}

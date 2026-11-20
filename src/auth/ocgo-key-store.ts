import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { isOCGoKey, isOCGoModelId } from "../ocgo-config.js";
import { getDataDir } from "../paths.js";

export const OCGoCredentialInputSchema = z.object({
  name: z.string().trim().min(1).max(100),
  apiKey: z.string().refine(isOCGoKey),
  models: z.array(z.string().refine(isOCGoModelId)).min(1).max(200),
  enabled: z.boolean(),
  /** Administrator-confirmed quota owner; missing/null is unknown, not independent. */
  quotaGroup: z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/).nullable().optional(),
}).strict();
const credentialSchema = OCGoCredentialInputSchema.extend({ id: z.string().uuid() });
export const MAX_OCGO_CREDENTIALS = 100;
const fileSchema = z.object({ version: z.literal(1), credentials: z.array(credentialSchema).max(MAX_OCGO_CREDENTIALS) }).strict();

/** Server-internal credential. Never serialize it into a response or a log. */
export type OCGoCredential = z.infer<typeof credentialSchema>;

function parseStore(raw: unknown): OCGoCredential[] {
  const result = fileSchema.safeParse(raw);
  if (!result.success) throw new Error("Invalid OCGo credential store");
  const { credentials } = result.data;
  if (new Set(credentials.map((entry) => entry.id)).size !== credentials.length ||
      new Set(credentials.map((entry) => entry.apiKey)).size !== credentials.length) {
    throw new Error("Duplicate OCGo credentials");
  }
  for (const entry of credentials) entry.models = [...new Set(entry.models)];
  return credentials;
}

/** Separate from Custom and from exportable app settings. File access relies on the app data directory ACL. */
export class OCGoKeyStore {
  readonly #file: string;

  constructor(file = join(getDataDir(), "ocgo-keys.json")) {
    this.#file = file;
  }

  readCredentials(): OCGoCredential[] {
    let raw: string;
    try {
      raw = readFileSync(this.#file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Cannot read OCGo credential store");
    }
    // JSON.parse errors can include a snippet of the secret-bearing file.
    let data: unknown;
    try { data = JSON.parse(raw); } catch { throw new Error("Invalid OCGo credential store"); }
    return parseStore(data);
  }

  replaceCredentials(credentials: readonly OCGoCredential[]): void {
    const entries = parseStore({ version: 1, credentials });
    const temp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      mkdirSync(dirname(this.#file), { recursive: true, mode: 0o700 });
      writeFileSync(temp, `${JSON.stringify({ version: 1, credentials: entries })}\n`, { flag: "wx", mode: 0o600 });
      renameSync(temp, this.#file);
    } catch {
      try { rmSync(temp, { force: true }); } catch { /* keep the original file intact */ }
      throw new Error("Cannot save OCGo credential store");
    }
  }
}

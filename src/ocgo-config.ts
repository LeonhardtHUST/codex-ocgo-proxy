import { z } from "zod";
import {
  hasOpenCodeNamespace,
  isOpenCodeModelId,
  stripOpenCodeNamespace,
} from "./opencode/namespace.js";

// A fixed numeric loopback authority avoids DNS, userinfo, and ambiguous URL forms.
// Rust serves /v1/responses; don't let a configuration value change the request path.
export function ocgoResponsesUrl(baseUrl: string): string | undefined {
  if (baseUrl !== baseUrl.trim() || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[1-9][0-9]{0,4}\/v1\/?$/.test(baseUrl)) {
    return undefined;
  }
  try {
    return `${new URL(baseUrl).origin}/v1/responses`;
  } catch {
    return undefined; // e.g. port > 65535
  }
}

export const OCGoConfigSchema = z.object({
  enabled: z.boolean().default(false),
  base_url: z.string().refine((value) => ocgoResponsesUrl(value) !== undefined, {
    message: "OCGo base_url must be http://127.0.0.1:<port>/v1 or http://[::1]:<port>/v1",
  }).default("http://127.0.0.1:8787/v1"),
  timeout_seconds: z.number().int().min(1).max(600).default(180),
}).strict().default({});

export const OCGO_MODEL_PREFIX = "ocgo:";

// Prefix handling now lives in the namespace module so `opencode:` and the three
// tier prefixes behave identically to the legacy `ocgo:` prefix during migration.
export const hasOCGoModelPrefix = (value: string): boolean => hasOpenCodeNamespace(value, { legacyOcgo: true });

export const stripOCGoModelPrefix = (value: string): string | null => stripOpenCodeNamespace(value, { legacyOcgo: true });

export const isOCGoModelId = (value: string): boolean => isOpenCodeModelId(value);

export const isOCGoKey = (value: string): boolean =>
  value.length > 0 && value.length <= 4096 && !/[^A-Za-z0-9._~+/=-]/.test(value);

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { JSX } from "preact";
import { useI18n } from "../../../shared/i18n/context";

const path = "/admin/opencode/keys";
const button = "rounded-lg border border-gray-200 dark:border-border-dark px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-bg-dark disabled:opacity-50";
const field = "w-full rounded-lg border border-gray-200 dark:border-border-dark bg-white dark:bg-bg-dark px-3 py-2";

type Tokens = { total: number | null; unknown: number };
interface Credential {
  id: string;
  name: string;
  models: string[];
  enabled: boolean;
  quotaGroup: string | null;
  invalid: boolean;
  deniedModels: string[];
  busy: boolean;
  cooldownUntil: number | null;
  upstreamAttempts: { started: number; succeeded: number; failed: number; cancelled: number; inputTokens: Tokens; outputTokens: Tokens; cachedTokens: Tokens };
}
interface Snapshot {
  enabled: boolean;
  clientRequests: { started: number; succeeded: number; failed: number; cancelled: number };
  credentials: Credential[];
}

export function OpenCodeKeysPage({ masterApiKey }: { masterApiKey?: string }) {
  const { lang, t } = useI18n();
  const zh = lang === "zh";
  const label = (english: string, chinese: string) => zh ? chinese : english;
  const unknown = label("Unknown", "未知");
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Credential | "new" | null>(null);
  const [confirm, setConfirm] = useState<{ action: "verify" | "remove"; entry: Credential } | null>(null);

  const call = useCallback(async (suffix: string, method: string, body?: object, signal?: AbortSignal) => {
    const headers = new Headers();
    if (masterApiKey && !["Loading...", "any-string"].includes(masterApiKey)) headers.set("Authorization", `Bearer ${masterApiKey}`);
    if (body !== undefined) headers.set("Content-Type", "application/json");
    const res = await fetch(path + suffix, {
      method, headers, signal, credentials: "same-origin", redirect: "error", cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Never display arbitrary response text in a credential form.
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  }, [masterApiKey]);
  const load = useCallback(async (signal?: AbortSignal) => {
    const data = await (await call("", "GET", undefined, signal)).json() as Snapshot;
    if (!signal?.aborted) setSnapshot(data);
  }, [call]);
  useEffect(() => {
    if (masterApiKey === "Loading...") return;
    const controller = new AbortController();
    setError("");
    void load(controller.signal).catch(() => { if (!controller.signal.aborted) setError("load"); });
    return () => controller.abort();
  }, [load, masterApiKey]);

  async function run(action: () => Promise<unknown>, onDone?: () => void, message?: string) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      onDone?.();
      if (message) setNotice(message);
      await load();
    } catch (e) {
      setError(e instanceof Error && /^HTTP \d{3}$/.test(e.message) ? e.message : "load");
      // A failed verification can still update the credential health counters.
      await load().catch(() => {});
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }

  function save(event: JSX.TargetedEvent<HTMLFormElement, Event>) {
    event.preventDefault();
    if (!editing || pending.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = form.elements.namedItem("apiKey") as HTMLInputElement;
    const apiKey = password.value.trim();
    password.value = "";
    const quotaGroup = String(data.get("quotaGroup") ?? "").trim();
    const body = {
      name: String(data.get("name")).trim(),
      models: [...new Set(String(data.get("models")).split(/[\s,]+/).filter(Boolean))],
      ...(apiKey ? { apiKey } : {}),
      // Do not implicitly reconfirm ownership of a replacement Key.
      ...(editing === "new" || !apiKey ? { quotaGroup: quotaGroup || null } : {}),
    };
    const creating = editing === "new";
    void run(() => call(creating ? "" : `/${encodeURIComponent(editing.id)}`, creating ? "POST" : "PATCH", body), () => setEditing(null));
  }

  const tokenText = (value: Tokens) => value.total === null ? unknown :
    `${value.total.toLocaleString()}${value.unknown ? ` (${value.unknown} ${label("unknown", "次未知")})` : ""}`;
  const requests = snapshot?.clientRequests;

  return <section class="space-y-4 text-slate-800 dark:text-text-main">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold">OpenCode</h1>
        <p class="text-sm text-slate-500 dark:text-text-dim">{label("Manage OpenCode Go credentials for HTTP Responses. Request models as opencode-go:<model> (the legacy ocgo: prefix still works).", "管理 HTTP Responses 使用的 OpenCode Go 凭据。请求模型时使用 opencode-go:<模型>（旧的 ocgo: 前缀仍可用）。")}</p>
      </div>
      <div class="flex gap-2">
        <button type="button" class={button} disabled={busy || masterApiKey === "Loading..."} onClick={() => void run(async () => {})}>{label("Refresh", "刷新")}</button>
        <button type="button" class={button} disabled={busy || !snapshot} onClick={() => { setConfirm(null); setEditing("new"); }}>{label("Add Go Key", "新增 Go Key")}</button>
      </div>
    </div>
    {error && <p role="alert" class="text-sm text-red-600 dark:text-red-400">{label("OpenCode operation failed. Check the administrator session and key configuration.", "OpenCode 操作失败，请检查管理员会话和凭据配置。")} {error !== "load" && error}</p>}
    {notice && <p role="status" class="text-sm">{notice}</p>}
    {requests && <p class="text-sm text-slate-500 dark:text-text-dim">
      {label("Client requests", "客户端请求")}: {requests.started} · {label("Succeeded", "成功")}: {requests.succeeded} · {label("Failed", "失败")}: {requests.failed} · {label("Cancelled", "取消")}: {requests.cancelled}. {label("Official quota: unknown. Local counters reset on restart.", "官方配额未知。本地计数在重启后清零。")}
    </p>}
    {editing && <form key={editing === "new" ? "new" : editing.id} class="space-y-3 rounded-lg border border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark p-4" onSubmit={save}>
      <h2 class="font-medium">{editing === "new" ? label("Add Go Key", "新增 Go Key") : label("Edit Go Key", "编辑 Go Key")}</h2>
      <fieldset disabled={busy} class="grid gap-3 sm:grid-cols-2">
        <label class="text-sm">{label("Name", "名称")}<input name="name" class={field} required maxLength={100} defaultValue={editing === "new" ? "" : editing.name} /></label>
        <label class="text-sm">{label("Models (comma-separated IDs)", "模型（以逗号分隔的 ID）")}<input name="models" class={field} required defaultValue={editing === "new" ? "" : editing.models.join(", ")} /></label>
        <label class="text-sm">{label(editing === "new" ? "Go API Key" : "Replacement Go API Key (optional)", editing === "new" ? "Go API Key" : "新 Go API Key（可选）")}<input name="apiKey" type="password" autoComplete="new-password" spellcheck={false} class={field} required={editing === "new"} maxLength={4096} /></label>
        <label class="text-sm">{label("Confirmed quota group (optional)", "已确认的额度组（可选）")}<input name="quotaGroup" class={field} maxLength={80} pattern="[A-Za-z0-9._\-]+" defaultValue={editing === "new" ? "" : editing.quotaGroup ?? ""} /></label>
      </fieldset>
      {editing !== "new" && <p class="text-xs text-slate-500 dark:text-text-dim">{label("Replacing the Key clears its quota group. Confirm the new group in a separate edit.", "替换 Key 会清除原额度组，请另行编辑确认新的额度组。")}</p>}
      <div class="flex gap-2"><button type="submit" class={button} disabled={busy}>{label("Save", "保存")}</button><button type="button" class={button} disabled={busy} onClick={() => setEditing(null)}>{t("cancel")}</button></div>
    </form>}
    {confirm && <form key={confirm.entry.id + confirm.action} class="space-y-3 rounded-lg border border-gray-200 dark:border-border-dark p-4" onSubmit={(event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
      event.preventDefault();
      const suffix = `/${encodeURIComponent(confirm.entry.id)}`;
      const model = new FormData(event.currentTarget).get("model");
      const verify = confirm.action === "verify";
      void run(() => verify ? call(`${suffix}/verify`, "POST", { model }) : call(suffix, "DELETE"), () => setConfirm(null), verify ? label("Verification completed.", "验证已完成。") : label("Key removed locally.", "本地 Key 已移除。"));
    }}>
      <p class="text-sm">{confirm.action === "verify" ? label("Verification sends one short generation request and may consume quota.", "验证会发送一次短生成请求，可能消耗额度。") : label("Remove this stored Key? This does not revoke it at the provider.", "移除此本地 Key？供应商端的 Key 不会被撤销。")}</p>
      {confirm.action === "verify" && <label class="block text-sm">{label("Verification model", "验证模型")}<select name="model" class={field} disabled={busy} required>{confirm.entry.models.filter((model) => !confirm.entry.deniedModels.includes(model)).map((model) => <option key={model} value={model}>{model}</option>)}</select></label>}
      <div class="flex gap-2"><button class={button} disabled={busy} type="submit">{label("Confirm", "确认")}</button><button class={button} disabled={busy} type="button" onClick={() => setConfirm(null)}>{t("cancel")}</button></div>
    </form>}
    {snapshot?.credentials.length === 0 && <p class="text-sm">{label("No OpenCode credentials added.", "尚未添加 OpenCode 凭据。")}</p>}
    {snapshot?.credentials.map((key) => {
      const attempts = key.upstreamAttempts;
      const cooling = (key.cooldownUntil ?? 0) > Date.now();
      const status = !key.enabled ? label("Disabled", "已禁用") : key.invalid ? label("Invalid", "已失效") : cooling ? label("Cooling down", "冷却中") : key.busy ? label("Busy", "使用中") : label("Enabled", "已启用");
      return <article key={key.id} class="space-y-2 rounded-lg border border-gray-200 dark:border-border-dark bg-white dark:bg-card-dark p-4">
        <div class="flex flex-wrap items-center justify-between gap-2"><h2 class="font-semibold break-all">{key.name}</h2><span class="text-xs">{status} · <code>{key.id.slice(0, 8)}</code></span></div>
        <p class="text-sm break-words">{key.models.map((model) => `opencode:${model}`).join(", ")}</p>
        {!!key.deniedModels.length && <p class="text-sm break-words">{label("Models denied", "无模型权限")}: {key.deniedModels.join(", ")}</p>}
        <p class="text-xs text-slate-500 dark:text-text-dim">{label("Quota group", "额度组")}: {key.quotaGroup ?? unknown} · {label("Upstream attempts", "上游尝试")}: {attempts.started} · {label("Succeeded", "成功")}: {attempts.succeeded} · {label("Failed", "失败")}: {attempts.failed} · {label("Cancelled", "取消")}: {attempts.cancelled}</p>
        <p class="text-xs text-slate-500 dark:text-text-dim">{label("Input tokens", "输入 token")}: {tokenText(attempts.inputTokens)} · {label("Output tokens", "输出 token")}: {tokenText(attempts.outputTokens)} · {label("Cached input", "缓存输入")}: {tokenText(attempts.cachedTokens)}</p>
        <div class="flex flex-wrap gap-2">
          <button class={button} disabled={busy} type="button" onClick={() => { setConfirm(null); setEditing(key); }}>{label("Edit / replace", "编辑 / 替换")}</button>
          <button class={button} disabled={busy} type="button" onClick={() => void run(() => call(`/${encodeURIComponent(key.id)}`, "PATCH", { enabled: !key.enabled }))}>{key.enabled ? label("Disable", "禁用") : label("Enable", "启用")}</button>
          <button class={button} disabled={busy || !key.enabled || cooling || key.invalid || key.busy || key.models.every((model) => key.deniedModels.includes(model))} type="button" onClick={() => { setEditing(null); setConfirm({ action: "verify", entry: key }); }}>{label("Verify", "验证")}</button>
          <button class={button} disabled={busy} type="button" onClick={() => { setEditing(null); setConfirm({ action: "remove", entry: key }); }}>{label("Remove", "移除")}</button>
        </div>
      </article>;
    })}
  </section>;
}

/**
 * Autostart settings card (Windows).
 *
 * The server owns the registry / task-scheduler writes, so this card is a thin client:
 * read the current state, apply a change, and surface the one case that needs user
 * interaction — an elevation prompt.
 */

import { useCallback, useEffect, useState } from "preact/hooks";
import { useSettings } from "../../../shared/hooks/use-settings";

type Mode = "registry" | "startup" | "task";
type Scope = "user" | "machine";

interface AutostartStatus {
  supported: boolean;
  registered: boolean;
  mode: Mode;
  scope: Scope;
  runAsAdmin: boolean;
  delaySeconds: number;
  elevationRequired: boolean;
  command: string;
  location: string;
  lastError?: string;
}

interface Snapshot {
  entry: string;
  settings: { mode: Mode; scope: Scope; runAsAdmin: boolean; delaySeconds: number };
  status: AutostartStatus;
}

const MODE_HINT: Record<Mode, string> = {
  registry: "Per-user Run key. Starts with your normal privileges, no UAC.",
  startup: "Startup folder wrapper. Supports a start delay, no UAC.",
  task: "Task Scheduler (ONLOGON). Needs admin once; can start elevated without a prompt at logon.",
};

export function AutostartSettings() {
  const settings = useSettings();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<{ enabled: boolean; mode: Mode; scope: Scope; runAsAdmin: boolean; delaySeconds: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [elevation, setElevation] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authHeaders = useCallback((): Record<string, string> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (settings.apiKey) headers.Authorization = `Bearer ${settings.apiKey}`;
    return headers;
  }, [settings.apiKey]);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/admin/autostart", { headers: authHeaders(), credentials: "same-origin" });
      if (!response.ok) throw new Error(`load failed (${response.status})`);
      const body = await response.json() as Snapshot;
      setSnapshot(body);
      setDraft({
        enabled: body.status.registered,
        mode: body.settings.mode,
        scope: body.settings.scope,
        runAsAdmin: body.settings.runAsAdmin,
        delaySeconds: body.settings.delaySeconds,
      });
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [authHeaders]);

  useEffect(() => { void load(); }, [load]);

  const apply = useCallback(async (enabled: boolean) => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    setElevation(false);
    try {
      const response = await fetch("/admin/autostart", {
        method: "POST",
        headers: authHeaders(),
        credentials: "same-origin",
        body: JSON.stringify({ enabled, mode: draft.mode, scope: draft.scope, runAsAdmin: draft.runAsAdmin, delaySeconds: draft.delaySeconds }),
      });
      if (response.status === 409) {
        setElevation(true);
        setNotice("Administrator rights are required. Retry with one Windows prompt, or pick a per-user mode.");
        return;
      }
      if (!response.ok) throw new Error(`apply failed (${response.status})`);
      setNotice(enabled ? "Autostart registered." : "Autostart removed.");
      await load();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [draft, busy, authHeaders, load]);

  const elevate = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/admin/autostart/elevate", {
        method: "POST",
        headers: authHeaders(),
        credentials: "same-origin",
        body: JSON.stringify({ enabled }),
      });
      if (!response.ok) throw new Error(`elevation failed (${response.status})`);
      setNotice("Windows prompt opened. Approve it, then reload this card.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [authHeaders]);

  if (error && !snapshot) {
    return (
      <section class="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-surface p-4">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-text-main">Autostart</h2>
        <p class="mt-2 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>
      </section>
    );
  }

  if (!snapshot || !draft) {
    return (
      <section class="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-surface p-4">
        <h2 class="text-sm font-semibold text-slate-700 dark:text-text-main">Autostart</h2>
        <p class="mt-2 text-xs text-slate-500 dark:text-text-dim">Loading…</p>
      </section>
    );
  }

  const supported = snapshot.status.supported;
  const inputCls = "rounded border border-slate-300 dark:border-border bg-white dark:bg-surface px-2 py-1 text-xs";

  return (
    <section class="rounded-lg border border-slate-200 dark:border-border bg-white dark:bg-surface p-4">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h2 class="text-sm font-semibold text-slate-700 dark:text-text-main">Autostart</h2>
          <p class="mt-1 text-xs text-slate-500 dark:text-text-dim">
            {supported
              ? (snapshot.status.registered
                ? `Registered: ${snapshot.status.location}`
                : "Not registered.")
              : "Only implemented for Windows."}
          </p>
        </div>
        <span class={`rounded px-2 py-0.5 text-[0.7rem] ${snapshot.status.registered ? "bg-emerald-100 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
          {snapshot.status.registered ? "on" : "off"}
        </span>
      </div>

      {!supported && (
        <p class="mt-3 text-xs text-slate-500 dark:text-text-dim">
          macOS (launchd) and Linux (systemd user unit) support is not implemented yet — the API reports it honestly instead of failing silently.
        </p>
      )}

      {supported && (
        <>
          <div class="mt-3 grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-xs">
              <span class="text-slate-500 dark:text-text-dim">Mode</span>
              <select class={inputCls} value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: (event.currentTarget as HTMLSelectElement).value as Mode })}>
                <option value="registry">registry (Run key)</option>
                <option value="startup">startup (folder wrapper)</option>
                <option value="task">task (Task Scheduler)</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-xs">
              <span class="text-slate-500 dark:text-text-dim">Scope</span>
              <select class={inputCls} value={draft.scope} onChange={(event) => setDraft({ ...draft, scope: (event.currentTarget as HTMLSelectElement).value as Scope })}>
                <option value="user">user</option>
                <option value="machine">machine (all users, needs admin)</option>
              </select>
            </label>
            <label class="flex flex-col gap-1 text-xs">
              <span class="text-slate-500 dark:text-text-dim">Delay (seconds, startup mode)</span>
              <input
                type="number" min={0} max={600} class={inputCls} value={draft.delaySeconds}
                onInput={(event) => setDraft({ ...draft, delaySeconds: Number((event.currentTarget as HTMLInputElement).value) || 0 })}
              />
            </label>
            <label class="flex items-center gap-2 self-end text-xs">
              <input
                type="checkbox" checked={draft.runAsAdmin}
                onChange={(event) => setDraft({ ...draft, runAsAdmin: (event.currentTarget as HTMLInputElement).checked })}
              />
              Start elevated (task mode, RL HIGHEST)
            </label>
          </div>

          <p class="mt-2 text-[0.7rem] text-slate-500 dark:text-text-dim">{MODE_HINT[draft.mode]}</p>
          <p class="mt-1 break-all text-[0.7rem] text-slate-400">{snapshot.status.command}</p>

          <div class="mt-3 flex flex-wrap gap-2">
            <button class="rounded bg-emerald-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void apply(true)}>
              Enable
            </button>
            <button class="rounded border border-slate-300 dark:border-border px-3 py-1 text-xs disabled:opacity-50" disabled={busy} onClick={() => void apply(false)}>
              Disable
            </button>
            <button class="rounded border border-slate-300 dark:border-border px-3 py-1 text-xs disabled:opacity-50" disabled={busy} onClick={() => void load()}>
              Reload
            </button>
          </div>
        </>
      )}

      {elevation && (
        <div class="mt-3 rounded border border-amber-300 bg-amber-50 dark:bg-amber-900/20 p-2">
          <p class="text-xs text-amber-800 dark:text-amber-200">This mode needs administrator rights.</p>
          <button class="mt-2 rounded bg-amber-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-50" disabled={busy} onClick={() => void elevate(true)}>
            Retry through Windows prompt
          </button>
        </div>
      )}

      {notice && !elevation && <p class="mt-3 text-xs text-slate-600 dark:text-text-main" role="status">{notice}</p>}
      {error && <p class="mt-3 text-xs text-red-600 dark:text-red-400" role="alert">{error}</p>}
      {snapshot.status.lastError && <p class="mt-2 text-[0.7rem] text-slate-400">Last error: {snapshot.status.lastError}</p>}
    </section>
  );
}

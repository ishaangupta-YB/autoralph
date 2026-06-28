"use client";

import { useCallback, useEffect, useState } from "react";

import type { ControlCapabilities } from "@/lib/board";

export interface ControlState extends ControlCapabilities {
  connected: boolean;
  demo: boolean;
  error?: string;
}

const INITIAL: ControlState = {
  canLaunch: false,
  agents: [],
  liveRuns: [],
  connected: false,
  demo: false,
};

interface CapsResponse extends ControlCapabilities {
  connected: boolean;
  demo: boolean;
  error?: string;
}

/**
 * Polls `GET /api/control` for launch capabilities and the set of live run
 * ids. Polling (rather than SSE) is fine here: capabilities change rarely and
 * the live-run set is also reflected in the snapshot stream.
 */
export function useControl(): { caps: ControlState; refresh: () => void } {
  const [caps, setCaps] = useState<ControlState>(INITIAL);

  const refresh = useCallback(() => {
    fetch("/api/control", { cache: "no-store" })
      .then((res) => res.json() as Promise<CapsResponse>)
      .then((data) =>
        setCaps({
          canLaunch: Boolean(data.canLaunch),
          agents: data.agents ?? [],
          liveRuns: data.liveRuns ?? [],
          connected: Boolean(data.connected),
          demo: Boolean(data.demo),
          error: data.error,
        }),
      )
      .catch(() => {
        /* keep last known capabilities */
      });
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { caps, refresh };
}

export interface LaunchFormProps {
  caps: ControlState;
  onLaunched?: (runId: string) => void;
}

type Pending = "idle" | "submitting";

/**
 * Start-a-run form. Hidden unless the board reports `canLaunch` (a board
 * started with run control). Posts `{ action: "start", ... }` to the control
 * proxy and surfaces the resulting run id or error inline.
 */
export function LaunchForm({ caps, onLaunched }: LaunchFormProps) {
  const [objective, setObjective] = useState("");
  const [agent, setAgent] = useState("");
  const [maxIterations, setMaxIterations] = useState("");
  const [pending, setPending] = useState<Pending>("idle");
  const [message, setMessage] = useState<string | null>(null);

  if (!caps.canLaunch) {
    return (
      <div className="launch launch--disabled">
        <p className="launch__note">
          Run control is disabled on this board. Start it with{" "}
          <code>autoralph --board</code> (control is on by default; use{" "}
          <code>--no-control</code> to disable) to launch runs from here.
        </p>
      </div>
    );
  }

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = objective.trim();
    if (!trimmed || pending === "submitting") return;
    setPending("submitting");
    setMessage(null);

    const body: Record<string, unknown> = { action: "start", objective: trimmed };
    if (agent) body.agent = agent;
    const iters = Number.parseInt(maxIterations, 10);
    if (Number.isFinite(iters) && iters > 0) body.maxIterations = iters;

    fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          runId?: string;
          error?: string;
        };
        if (res.ok && data.runId) {
          setObjective("");
          setMessage(`Launched ${data.runId}`);
          onLaunched?.(data.runId);
        } else {
          setMessage(data.error ?? `Launch failed (${res.status})`);
        }
      })
      .catch((err: unknown) =>
        setMessage(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setPending("idle"));
  };

  return (
    <form className="launch" onSubmit={submit} aria-label="Start a run">
      <textarea
        className="launch__obj"
        placeholder="Objective — what should the agent accomplish?"
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        rows={2}
      />
      <div className="launch__row">
        <select
          className="launch__agent"
          value={agent}
          onChange={(e) => setAgent(e.target.value)}
          aria-label="Agent"
        >
          <option value="">default agent</option>
          {caps.agents.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input
          className="launch__iters"
          type="number"
          min={1}
          placeholder="max iters"
          value={maxIterations}
          onChange={(e) => setMaxIterations(e.target.value)}
          aria-label="Max iterations"
        />
        <button
          type="submit"
          className="launch__go"
          disabled={pending === "submitting" || objective.trim() === ""}
        >
          {pending === "submitting" ? "Starting…" : "Start run"}
        </button>
      </div>
      {message ? <p className="launch__msg">{message}</p> : null}
    </form>
  );
}

export interface StopControlsProps {
  runId: string;
  onStopped?: () => void;
}

/** Graceful-stop / force-stop buttons shown on a live run. */
export function StopControls({ runId, onStopped }: StopControlsProps) {
  const [pending, setPending] = useState(false);

  const send = (action: "stop" | "force-stop") => {
    if (pending) return;
    setPending(true);
    fetch("/api/control", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, runId }),
    })
      .then(() => onStopped?.())
      .catch(() => {
        /* surfaced via the snapshot stream */
      })
      .finally(() => setPending(false));
  };

  return (
    <div className="stopctl">
      <button
        type="button"
        className="ghost-btn"
        disabled={pending}
        onClick={() => send("stop")}
      >
        Stop
      </button>
      <button
        type="button"
        className="ghost-btn ghost-btn--danger"
        disabled={pending}
        onClick={() => send("force-stop")}
      >
        Force
      </button>
    </div>
  );
}

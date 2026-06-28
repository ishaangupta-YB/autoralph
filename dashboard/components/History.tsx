"use client";

import { useCallback, useEffect, useState } from "react";

import {
  type PersistedRun,
  type RunHistorySummary,
  totalTokens,
} from "@/lib/board";
import { fmtCount } from "@/lib/format";
import { BoardColumns, LogBand, Metric, StatusBadge } from "@/components/Board";

interface ListResponse {
  connected: boolean;
  demo: boolean;
  runs: RunHistorySummary[];
  error?: string;
}

interface DetailResponse {
  connected: boolean;
  demo: boolean;
  run: PersistedRun | null;
  error?: string;
}

type LoadState = "loading" | "ready" | "down";

export default function HistoryView({ demo }: { demo: boolean }) {
  const [runs, setRuns] = useState<RunHistorySummary[]>([]);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(() => {
    // Keep all setState in promise callbacks (never synchronous in an effect)
    // so the data fetch satisfies react-hooks/set-state-in-effect.
    fetch("/api/history", { cache: "no-store" })
      .then((res) => res.json() as Promise<ListResponse>)
      .then((data) => {
        setRuns(data.runs ?? []);
        setError(data.error ?? null);
        setState(data.connected || data.demo ? "ready" : "down");
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setState("down");
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (state === "loading") {
    return <div className="history-empty">Loading history…</div>;
  }

  return (
    <>
      <section aria-label="Run history">
        <div className="section-head">
          <h2>Past runs</h2>
          <div className="history-head-actions">
            <span className="label">
              {runs.length} {runs.length === 1 ? "run" : "runs"}
            </span>
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void refresh()}
            >
              Refresh
            </button>
          </div>
        </div>

        {state === "down" ? (
          <div className="notice">
            <p>
              No board connected{error ? ` (${error})` : ""}. History is read
              from the CLI board&apos;s <code>.autoralph/history/</code>. Start
              a run, or preview with{" "}
              <code>AUTORALPH_DASHBOARD_DEMO=1 npm run dev</code>.
            </p>
          </div>
        ) : runs.length === 0 ? (
          <div className="history-empty">
            No runs recorded yet. Finished runs appear here automatically.
          </div>
        ) : (
          <div className="history-list">
            {runs.map((run) => (
              <HistoryRow
                key={run.runId}
                run={run}
                open={selected === run.runId}
                onOpen={() =>
                  setSelected((cur) => (cur === run.runId ? null : run.runId))
                }
              />
            ))}
          </div>
        )}
      </section>

      {selected ? (
        <RunDetail
          key={selected}
          runId={selected}
          demo={demo}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </>
  );
}

function HistoryRow({
  run,
  open,
  onOpen,
}: {
  run: RunHistorySummary;
  open: boolean;
  onOpen: () => void;
}) {
  const tokens = totalTokens(run.usage);
  return (
    <button
      type="button"
      className={`history-row ${open ? "history-row--on" : ""}`}
      onClick={onOpen}
      aria-expanded={open}
    >
      <div className="history-row__main">
        <div className="history-row__top">
          <span className="history-row__agent">{run.agent}</span>
          <StatusBadge status={run.status} />
          {run.live ? <span className="badge badge--running">live</span> : null}
        </div>
        <p className="history-row__obj" title={run.objective}>
          {run.objective}
        </p>
        <span className="history-row__when">{relTime(run.startedAt)}</span>
      </div>
      <div className="history-row__metrics">
        <Metric
          value={`${run.currentIteration}${
            run.maxIterations ? `/${run.maxIterations}` : ""
          }`}
          label="iter"
        />
        <Metric value={String(run.commitCount)} label="commits" />
        <Metric
          value={`${run.successCount}/${run.failCount}`}
          label="ok/fail"
        />
        <Metric
          value={`${run.usage.estimated ? "~" : ""}${fmtCount(tokens)}`}
          label="tokens"
        />
      </div>
    </button>
  );
}

function RunDetail({
  runId,
  demo,
  onClose,
}: {
  runId: string;
  demo: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<PersistedRun | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Mounted fresh per run via `key={runId}`, so initial state is "loading".
    let cancelled = false;
    fetch(`/api/history?runId=${encodeURIComponent(runId)}`, {
      cache: "no-store",
    })
      .then((res) => res.json() as Promise<DetailResponse>)
      .then((data) => {
        if (cancelled) return;
        setDetail(data.run);
        setError(data.error ?? null);
        setState(data.run ? "ready" : "down");
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("down");
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <section className="detail" aria-label="Run detail">
      <div className="section-head">
        <h2>
          Run detail <span className="mono detail__id">{runId}</span>
        </h2>
        <button type="button" className="ghost-btn" onClick={onClose}>
          Close
        </button>
      </div>

      {state === "loading" ? (
        <div className="history-empty">Loading run…</div>
      ) : state === "down" || !detail ? (
        <div className="notice">
          <p>Could not load this run{error ? ` (${error})` : ""}.</p>
        </div>
      ) : (
        <>
          <p className="detail__obj">{detail.run.objective}</p>
          <BoardColumns runs={[detail.run]} />
          <div className="detail__log">
            <LogBand logs={detail.logs} count={detail.logs.length} />
          </div>
          {demo ? <span className="demo-flag">demo data</span> : null}
        </>
      )}
    </section>
  );
}

/** Compact relative time like "3h ago" / "just now". */
function relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

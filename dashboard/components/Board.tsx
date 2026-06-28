"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import {
  type BoardSnapshot,
  type IterationView,
  type RunView,
  totalTokens,
} from "@/lib/board";
import { COLUMNS, fmtCount, fmtTime, runColor } from "@/lib/format";

type ConnState = "connecting" | "live" | "down";

const EMPTY: BoardSnapshot = { runs: [], logs: [], startedAt: Date.now() };

export interface DashboardProps {
  boardUrl: string;
  demo: boolean;
}

export default function Dashboard({ boardUrl, demo }: DashboardProps) {
  const [snapshot, setSnapshot] = useState<BoardSnapshot>(EMPTY);
  const [conn, setConn] = useState<ConnState>("connecting");
  const [boardError, setBoardError] = useState<string | null>(null);
  const reveal = useReveal();

  useEffect(() => {
    const source = new EventSource("/api/events");
    source.onopen = () => setConn("live");
    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as BoardSnapshot;
        setSnapshot(data);
        setBoardError(null);
        setConn("live");
      } catch {
        // ignore malformed frame
      }
    };
    source.addEventListener("board-error", (event) => {
      try {
        const { message } = JSON.parse((event as MessageEvent).data);
        setBoardError(typeof message === "string" ? message : "board unreachable");
      } catch {
        setBoardError("board unreachable");
      }
      setConn("down");
    });
    source.onerror = () =>
      setConn((prev) => (prev === "live" ? "down" : "connecting"));
    return () => source.close();
  }, []);

  const { runs, logs } = snapshot;
  const hasRuns = runs.length > 0;

  return (
    <div className="shell">
      <header className="nav">
        <div className="nav__inner">
          <span className="brand">
            <span className="brand__tick" aria-hidden="true" />
            <span className="brand__name">autoralph</span>
          </span>
          <span className="brand__sep" aria-hidden="true">
            /
          </span>
          <span className="label">control board</span>
          <div className="nav__meta">
            <span className="board-url mono">{boardUrl}</span>
            <ConnBadge state={conn} />
          </div>
        </div>
      </header>

      <main className="main">
        <div className="page-head">
          <h1>Agent runs, live.</h1>
          <p>
            Every iteration, commit, token budget, and provider fallback as the
            orchestrator drives each agent toward its objective.
          </p>
          {demo ? <span className="demo-flag">demo data</span> : null}
        </div>

        {boardError && !hasRuns ? (
          <div className="notice">
            <p>
              No board connected ({boardError}). Start a run with{" "}
              <code>autoralph &quot;objective&quot; --board-port 7654</code>, or
              preview the UI with{" "}
              <code>AUTORALPH_DASHBOARD_DEMO=1 npm run dev</code>.
            </p>
          </div>
        ) : null}

        {hasRuns ? (
          <>
            <section className="reveal" ref={reveal} aria-label="Run summary">
              <div className="section-head">
                <h2>Runs</h2>
                <span className="label">
                  {runs.length} {runs.length === 1 ? "run" : "runs"}
                </span>
              </div>
              <div className="runs">
                {runs.map((run, i) => (
                  <RunCard key={run.runId} run={run} color={runColor(i)} />
                ))}
              </div>
            </section>

            <section className="reveal" ref={reveal} aria-label="Kanban board">
              <div className="section-head">
                <h2>Iterations</h2>
                <span className="label">live kanban</span>
              </div>
              <BoardColumns runs={runs} />
            </section>
          </>
        ) : null}

        <section className="reveal" ref={reveal} aria-label="Event log">
          <LogBand logs={logs} count={logs.length} />
        </section>
      </main>

      <footer className="foot">
        <div className="foot__inner">
          <span>autoralph · MIT</span>
          <span>·</span>
          <a
            href="https://github.com/ishaangupta-yb/autoralph"
            target="_blank"
            rel="noopener noreferrer"
          >
            github.com/ishaangupta-yb/autoralph
          </a>
        </div>
      </footer>
    </div>
  );
}

function ConnBadge({ state }: { state: ConnState }) {
  const cls =
    state === "live"
      ? "conn--live"
      : state === "down"
        ? "conn--down"
        : "conn--pulse";
  const text =
    state === "live" ? "live" : state === "down" ? "disconnected" : "connecting";
  return (
    <span className={`conn ${cls}`} role="status" aria-live="polite">
      <span className="conn__dot" aria-hidden="true" />
      {text}
    </span>
  );
}

function RunCard({ run, color }: { run: RunView; color: string }) {
  const tokens = totalTokens(run.usage);
  const pct = run.maxIterations
    ? Math.min(100, Math.round((run.currentIteration / run.maxIterations) * 100))
    : run.status === "completed"
      ? 100
      : 0;
  return (
    <article
      className="run-card"
      style={{ "--accent-bar": color } as React.CSSProperties}
    >
      <div className="run-card__top">
        <span className="run-card__agent">{run.agent}</span>
        <StatusBadge status={run.status} />
      </div>
      <p className="run-card__obj" title={run.objective}>
        {run.objective}
      </p>
      <div className="metrics">
        <Metric
          value={`${run.currentIteration}${
            run.maxIterations ? `/${run.maxIterations}` : ""
          }`}
          label="iter"
        />
        <Metric value={String(run.commitCount)} label="commits" />
        <Metric value={`${run.successCount}/${run.failCount}`} label="ok/fail" />
        <Metric
          value={`${run.usage.estimated ? "~" : ""}${fmtCount(tokens)}`}
          label="tokens"
        />
      </div>
      <div className="run-card__foot">
        <div
          className="bar"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <span className="bar__fill" style={{ width: `${pct}%` }} />
        </div>
        <span>{run.stopReason ?? run.branch}</span>
      </div>
    </article>
  );
}

function Metric({ value, label }: { value: string; label: string }) {
  return (
    <div className="metric">
      <div className="metric__v">{value}</div>
      <div className="metric__l">{label}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={`badge badge--${status}`}>{status}</span>;
}

interface BoardCard {
  iteration: IterationView;
  color: string;
}

function BoardColumns({ runs }: { runs: RunView[] }) {
  const cards = useMemo<BoardCard[]>(() => {
    const all: BoardCard[] = [];
    runs.forEach((run, i) =>
      run.iterations.forEach((iteration) =>
        all.push({ iteration, color: runColor(i) }),
      ),
    );
    return all;
  }, [runs]);

  return (
    <div className="board">
      {COLUMNS.map((col) => {
        const items = cards.filter((c) =>
          col.statuses.includes(c.iteration.status),
        );
        return (
          <div className="col" key={col.key}>
            <div className="col__head">
              <span className="col__title">{col.title}</span>
              <span className="col__count">{items.length}</span>
            </div>
            {items.length === 0 ? (
              <div className="col__empty">—</div>
            ) : (
              items.map((c) => (
                <IterationCard
                  key={`${c.iteration.agent}-${c.iteration.id}`}
                  card={c}
                />
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

function IterationCard({ card }: { card: BoardCard }) {
  const { iteration: it, color } = card;
  const tokens = totalTokens(it.usage);
  const running = it.status === "running";
  return (
    <article
      className={`card card--${it.status}`}
      style={{ "--card-accent": color } as React.CSSProperties}
    >
      <div className="card__head">
        <span className="card__iter">
          {running ? <span className="spinner" aria-hidden="true" /> : null}
          Iteration {it.iteration}
        </span>
        <span className="card__agent">{it.agent}</span>
      </div>
      {it.summary ? <div className="card__sum">{it.summary}</div> : null}
      {running && it.message ? (
        <div className="card__msg">{it.message}</div>
      ) : null}
      {it.error ? <div className="card__err">{it.error}</div> : null}
      {tokens ? (
        <div className="card__tok">
          {it.usage.estimated ? "~" : ""}
          {fmtCount(tokens)} tokens
        </div>
      ) : null}
    </article>
  );
}

function LogBand({
  logs,
  count,
}: {
  logs: BoardSnapshot["logs"];
  count: number;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [count]);

  const recent = logs.slice(-80);
  return (
    <div className="logband">
      <div className="logband__head">
        <span className="logband__title">Event log</span>
        <span className="logband__meta">{count} events</span>
      </div>
      <div className="logband__body" ref={bodyRef}>
        {recent.length === 0 ? (
          <div className="logband__empty">Waiting for events…</div>
        ) : (
          recent.map((log, i) => (
            <div className="logline" key={`${log.ts}-${i}`}>
              <span className="logline__ts">{fmtTime(log.ts)}</span>
              <span className={`logline__lv logline__lv--${log.level}`}>
                {log.level.toUpperCase()}
              </span>
              <span className="logline__msg">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Returns a ref callback that fades a section in on first paint via
 * IntersectionObserver — the only motion engine on the page.
 */
function useReveal() {
  const observer = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    return () => observer.current?.disconnect();
  }, []);
  return (node: HTMLElement | null) => {
    if (!node) return;
    if (!observer.current) {
      observer.current = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) entry.target.classList.add("is-in");
          }
        },
        { threshold: 0.08 },
      );
    }
    observer.current.observe(node);
  };
}

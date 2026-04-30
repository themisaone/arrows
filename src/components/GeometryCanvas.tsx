import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  parse,
  scriptDotsToMarkers,
  updatePointInScript,
  type BuildStep,
  type HelperLineSpec,
  type ParseOptions,
} from "../utils/parser";
import {
  Figure,
  Group,
  resetShapeRenderCounters,
  type Figure as FigureType,
} from "../utils/shapes";

const STORAGE_KEY = "arrows.script";
const LAYOUT_REROLL_KEY = "arrows.layoutReroll";
const DEFAULT_URL = "/figure.txt";
const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 760;

function readLayoutRerollFromSession(): string {
  try {
    return sessionStorage.getItem(LAYOUT_REROLL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeLayoutRerollToSession(value: string) {
  try {
    if (value) sessionStorage.setItem(LAYOUT_REROLL_KEY, value);
    else sessionStorage.removeItem(LAYOUT_REROLL_KEY);
  } catch {
    /* private mode / SSR */
  }
}

const BUILD_LOG_INTRO =
  "Tip: newest log lines appear at the top. Press Enter (outside the script box) or “Next step” to apply the next queued action. Gray dashed lines preview the upcoming step.";

const FALLBACK_SCRIPT = `# fallback (figure.txt not found)
point A 260 140
point B 200 620
point C 760 380
arc A B out C 0.32
arc A C in  B 0.22
arc A C out B 0.32
arc B C in  A 0.22
dot A B C
`;

function renderHelperLines(
  fig: FigureType,
  specs: HelperLineSpec[] | undefined,
  keyPrefix: string
): React.ReactNode {
  if (!specs?.length) return null;
  return specs.map((h, i) => {
    try {
      const a = fig.pt(h.from);
      const b = fig.pt(h.to);
      return (
        <line
          key={`${keyPrefix}-${i}-${h.from}-${h.to}`}
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          stroke="#64748b"
          strokeWidth={2}
          strokeDasharray="5 4"
          opacity={0.95}
          pointerEvents="none"
        />
      );
    } catch {
      return null;
    }
  });
}

/** Named-point chords (gray) plus optional arc polylines / ticks / upcoming dots for nest apex option 2. */
function renderStepThroughHelperOverlays(
  fig: FigureType,
  step: BuildStep,
  keyPrefix: string
): React.ReactNode {
  return (
    <g pointerEvents="none">
      {renderHelperLines(fig, step.helperLines, keyPrefix)}
      {step.helperPolylines?.map((pl, i) =>
        pl.points.length >= 2 ? (
          <polyline
            key={`${keyPrefix}-pl-${i}`}
            fill="none"
            stroke={pl.stroke ?? "#a21caf"}
            strokeWidth={pl.strokeWidth ?? 2}
            strokeLinejoin="round"
            strokeLinecap="round"
            points={pl.points.map((p) => `${p.x},${p.y}`).join(" ")}
            opacity={0.95}
          />
        ) : null
      )}
      {step.helperSegments?.map((s, i) => (
        <line
          key={`${keyPrefix}-seg-${i}`}
          x1={s.a.x}
          y1={s.a.y}
          x2={s.b.x}
          y2={s.b.y}
          stroke="#64748b"
          strokeWidth={1.6}
          strokeDasharray="4 3"
          opacity={0.92}
        />
      ))}
      {step.helperDots?.map((p, i) => (
        <circle
          key={`${keyPrefix}-dot-${i}`}
          cx={p.x}
          cy={p.y}
          r={5}
          fill="#059669"
          stroke="#ecfdf5"
          strokeWidth={1.5}
        />
      ))}
    </g>
  );
}

const GeometryCanvas: React.FC = () => {
  const [script, setScript] = useState<string>(
    () => localStorage.getItem(STORAGE_KEY) ?? ""
  );
  const [defaultScript, setDefaultScript] = useState<string>(FALLBACK_SCRIPT);
  const [drag, setDrag] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [stepThrough, setStepThrough] = useState(false);
  const [appliedSteps, setAppliedSteps] = useState(0);
  const [buildLog, setBuildLog] = useState<string[]>([]);
  /** When true, show macro helper dots + labels (`_ms…`, T*a/b, nest markers). Default off = drawing only. */
  const [showBuilderOverlays, setShowBuilderOverlays] = useState(false);
  /** When false, `dot` / `markers` in the script draw nothing. */
  const [showScriptDotCommands, setShowScriptDotCommands] = useState(true);
  /** When false, hide white drag rings on the canvas (edit points in the script instead). */
  const [showDragHandles, setShowDragHandles] = useState(true);
  const [drawAnimation, setDrawAnimation] = useState(true);
  const [drawSegmentMs, setDrawSegmentMs] = useState(260);
  const [centerImage, setCenterImage] = useState(true);
  const [drawAppliedSteps, setDrawAppliedSteps] = useState(0);
  /** Bumped to re-seed perp / nest / spike randomness without editing the script (persisted in sessionStorage). */
  const [layoutRerollNonce, setLayoutRerollNonce] = useState(readLayoutRerollFromSession);
  const scriptTextareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fetch(DEFAULT_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(r.statusText)))
      .then((txt) => {
        setDefaultScript(txt);
        if (!localStorage.getItem(STORAGE_KEY)) setScript(txt);
      })
      .catch(() => {
        if (!script) setScript(FALLBACK_SCRIPT);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (script) localStorage.setItem(STORAGE_KEY, script);
  }, [script]);

  const parseOpts: ParseOptions = useMemo(() => {
    const o: ParseOptions = {
      showMacroHelperLabels: showBuilderOverlays,
      showScriptDots: showScriptDotCommands,
    };
    const n = layoutRerollNonce.trim();
    if (n) o.randomLayoutNonce = n;
    return o;
  }, [showBuilderOverlays, showScriptDotCommands, layoutRerollNonce]);

  const fullParse = useMemo(
    () => parse(script, undefined, parseOpts),
    [script, parseOpts]
  );

  const steppedParse = useMemo(
    () =>
      stepThrough
        ? parse(script, undefined, { stepped: true, ...parseOpts })
        : null,
    [script, stepThrough, parseOpts]
  );
  const animatedParse = useMemo(
    () =>
      drawAnimation && !stepThrough
        ? parse(script, undefined, { stepped: true, ...parseOpts })
        : null,
    [script, drawAnimation, stepThrough, parseOpts]
  );

  const steps: BuildStep[] | undefined = steppedParse?.buildSteps;
  const animatedSteps: BuildStep[] | undefined = animatedParse?.buildSteps;

  useLayoutEffect(() => {
    if (!stepThrough) return;
    setAppliedSteps(0);
    setBuildLog([BUILD_LOG_INTRO]);
  }, [stepThrough, script]);

  useLayoutEffect(() => {
    if (!drawAnimation || stepThrough) return;
    setDrawAppliedSteps(0);
  }, [drawAnimation, stepThrough, script, parseOpts]);

  useEffect(() => {
    if (!drawAnimation || stepThrough) return;
    const total = animatedSteps?.length ?? 0;
    if (total === 0 || drawAppliedSteps >= total) return;
    const t = window.setTimeout(
      () => setDrawAppliedSteps((n) => Math.min(n + 1, total)),
      Math.max(20, drawSegmentMs)
    );
    return () => window.clearTimeout(t);
  }, [drawAnimation, stepThrough, animatedSteps, drawAppliedSteps, drawSegmentMs]);

  const displayFigure = useMemo(() => {
    if (!stepThrough && drawAnimation && animatedSteps?.length) {
      const replayFig = new Figure();
      for (let i = 0; i < drawAppliedSteps && i < animatedSteps.length; i++) {
        animatedSteps[i]!.apply(replayFig);
      }
      return replayFig;
    }
    if (!stepThrough || !steps?.length) {
      return fullParse.figure;
    }
    const r = parse(script, undefined, { stepped: true, ...parseOpts });
    const n = r.buildSteps?.length ?? 0;
    const replayFig = new Figure();
    for (let i = 0; i < appliedSteps && i < n; i++) {
      r.buildSteps![i].apply(replayFig);
    }
    return replayFig;
  }, [
    script,
    stepThrough,
    drawAnimation,
    animatedSteps,
    drawAppliedSteps,
    steps,
    appliedSteps,
    fullParse.figure,
    parseOpts,
  ]);

  const nextStepPreview = useMemo(() => {
    if (!stepThrough || !steps?.length || appliedSteps >= steps.length) {
      return null;
    }
    return steps[appliedSteps];
  }, [stepThrough, steps, appliedSteps]);

  const advanceStep = useCallback(() => {
    if (!stepThrough || !steps?.length) return;
    if (appliedSteps >= steps.length) return;
    const st = steps[appliedSteps];
    const raw = st.sourceLine.trimEnd();
    const execHeader =
      raw.length > 0
        ? `EXECUTING SCRIPT LINE ${st.lineNum}:\n${raw}\n`
        : `EXECUTING SCRIPT LINE ${st.lineNum}: (blank or comment-only line — build sub-step)\n`;
    setBuildLog((prev) => [
      `${execHeader}── ${st.message}`,
      ...prev,
    ]);
    setAppliedSteps((a) => a + 1);
  }, [stepThrough, steps, appliedSteps]);

  useEffect(() => {
    if (!stepThrough) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const t = e.target as Node | null;
      if (scriptTextareaRef.current?.contains(t)) return;
      e.preventDefault();
      advanceStep();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stepThrough, advanceStep]);

  const svgCoords = (e: React.PointerEvent) => {
    const svg = svgRef.current;
    if (!svg) return null;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const local = pt.matrixTransform(ctm.inverse());
    return { x: local.x, y: local.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = svgCoords(e);
    if (!p) return;
    setScript((prev) => updatePointInScript(prev, drag, p.x, p.y));
  };

  const sceneNode = useMemo(() => {
    resetShapeRenderCounters();
    return displayFigure.render();
  }, [displayFigure, script, stepThrough, appliedSteps, layoutRerollNonce, drawAnimation, drawSegmentMs]);

  const miniPreviewNode = useMemo(() => {
    resetShapeRenderCounters();
    return new Group([fullParse.figure], "translate(840 40) scale(0.18)").render();
  }, [fullParse.figure, script, layoutRerollNonce]);

  const viewBox = useMemo(() => {
    const b = displayFigure.bounds();
    const halfW = CANVAS_WIDTH * 0.5;
    const halfH = CANVAS_HEIGHT * 0.5;
    if (!centerImage || !b) {
      return { minX: 0, minY: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
    }
    const cx = (b.minX + b.maxX) * 0.5;
    const cy = (b.minY + b.maxY) * 0.5;
    return {
      minX: cx - halfW,
      minY: cy - halfH,
      width: CANVAS_WIDTH,
      height: CANVAS_HEIGHT,
    };
  }, [displayFigure, centerImage]);

  const handles: Array<{ name: string; x: number; y: number }> = [];
  const seenHandleNames = new Set<string>();
  for (const name of fullParse.freePoints) {
    if (seenHandleNames.has(name)) continue;
    seenHandleNames.add(name);
    try {
      const p = displayFigure.pt(name);
      handles.push({ name, x: p.x, y: p.y });
    } catch {
      /* not defined yet in step mode */
    }
  }

  const helperKey = `${appliedSteps}-${nextStepPreview?.message ?? ""}`;

  const resetToDefault = useCallback(() => {
    setScript(defaultScript);
    setDrag(null);
    setAppliedSteps(0);
    setBuildLog([BUILD_LOG_INTRO]);
    setLayoutRerollNonce("");
    writeLayoutRerollToSession("");
  }, [defaultScript]);

  /** Re-fetch `public/figure.txt` from the server and replace the editor (dev: picks up disk edits). */
  const reloadPublicFigureTxt = useCallback(() => {
    fetch(DEFAULT_URL, { cache: "no-store" })
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((txt) => {
        setDefaultScript(txt);
        setScript(txt);
        setDrag(null);
        setAppliedSteps(0);
        setBuildLog([BUILD_LOG_INTRO]);
        setLayoutRerollNonce("");
        writeLayoutRerollToSession("");
      })
      .catch(() => {
        console.warn("Could not reload", DEFAULT_URL);
      });
  }, []);

  return (
    <div className="w-full h-screen bg-slate-100 p-3 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h1 className="text-lg font-bold tracking-tight">Arc Figure</h1>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={stepThrough}
              onChange={(e) => setStepThrough(e.target.checked)}
              className="rounded border-slate-400"
            />
            Step-through
          </label>
          <label
            className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer select-none"
            title="When checked: magenta _ms… helpers, blue T*a/T*b, nest mid/projection, green apex, spike tip markers (with names). When unchecked: none of those dots — only strokes/fills from the real geometry."
          >
            <input
              type="checkbox"
              checked={showBuilderOverlays}
              onChange={(e) => setShowBuilderOverlays(e.target.checked)}
              className="rounded border-slate-400"
            />
            Builder overlays
          </label>
          <label
            className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer select-none"
            title="Uncheck to hide script `dot` / `markers` output (A B C markers, etc.)"
          >
            <input
              type="checkbox"
              checked={showScriptDotCommands}
              onChange={(e) => setShowScriptDotCommands(e.target.checked)}
              className="rounded border-slate-400"
            />
            Script dots
          </label>
          <label
            className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer select-none"
            title="Uncheck for a clean export view: no white drag rings (you can still edit coordinates in the script)."
          >
            <input
              type="checkbox"
              checked={showDragHandles}
              onChange={(e) => setShowDragHandles(e.target.checked)}
              className="rounded border-slate-400"
            />
            Drag handles
          </label>
          <label
            className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer select-none"
            title="Animate the figure as if drawn stroke-by-stroke."
          >
            <input
              type="checkbox"
              checked={drawAnimation}
              onChange={(e) => setDrawAnimation(e.target.checked)}
              className="rounded border-slate-400"
            />
            Draw animation
          </label>
          <label
            className="flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer select-none"
            title="Pan camera so current drawing stays centered in the viewport."
          >
            <input
              type="checkbox"
              checked={centerImage}
              onChange={(e) => setCenterImage(e.target.checked)}
              className="rounded border-slate-400"
            />
            Center image
          </label>
          {drawAnimation && (
            <label
              className="flex items-center gap-1.5 text-xs font-medium text-slate-700"
              title="Lower = faster reveal; higher = slower line-by-line drawing."
            >
              Speed
              <input
                type="range"
                min={80}
                max={520}
                step={1}
                value={drawSegmentMs}
                onChange={(e) => setDrawSegmentMs(Number(e.target.value))}
                className="w-24"
              />
            </label>
          )}
          <label className="text-xs font-semibold px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100 bg-white cursor-pointer">
            Load file...
            <input
              type="file"
              accept=".txt,text/plain"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setScript(await f.text());
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            onClick={reloadPublicFigureTxt}
            title="Fetch public/figure.txt again (use after editing that file; refresh alone keeps localStorage)"
            className="text-xs font-semibold px-3 py-1.5 rounded border border-sky-300 hover:bg-sky-50 bg-white text-sky-900"
          >
            Reload figure.txt
          </button>
          <button
            type="button"
            onClick={resetToDefault}
            title="Restore last fetched default (same as Reload if you have not edited elsewhere)"
            className="text-xs font-semibold px-3 py-1.5 rounded border border-slate-300 hover:bg-slate-100 bg-white"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => setScript((s) => scriptDotsToMarkers(s))}
            title="Replace each `dot` line with `markers` so dots stay but text labels are removed"
            className="text-xs font-semibold px-3 py-1.5 rounded border border-violet-300 hover:bg-violet-50 bg-white text-violet-900"
          >
            Dot markers only
          </button>
          <button
            type="button"
            onClick={() => {
              const n = String(Date.now());
              setLayoutRerollNonce(n);
              writeLayoutRerollToSession(n);
            }}
            title="Re-roll random perp/nest apex offsets and spike tip lengths (same script). Survives refresh until Reset / Reload figure.txt. Does not change localStorage script text."
            className="text-xs font-semibold px-3 py-1.5 rounded border border-amber-400 hover:bg-amber-50 bg-white text-amber-950"
          >
            New random layout
          </button>
        </div>
      </div>

      <div className="flex-grow flex gap-3 min-h-0">
        <div className="w-[28rem] flex flex-col bg-white rounded-lg shadow-md overflow-hidden">
          <div className="px-3 py-1.5 border-b border-slate-200 text-xs font-semibold text-slate-600 flex items-center justify-between">
            <span>figure.txt</span>
            <span className="text-slate-400 font-normal">
              {fullParse.freePoints.length} point
              {fullParse.freePoints.length === 1 ? "" : "s"}
              {(fullParse.infos?.length ?? 0) > 0 && (
                <span
                  className="text-sky-700"
                  title="Nest apex clearance / retry notes (see panel below)"
                >
                  {" "}
                  · nest notes {fullParse.infos!.length}
                </span>
              )}
            </span>
          </div>
          <textarea
            ref={scriptTextareaRef}
            value={script}
            onChange={(e) => setScript(e.target.value)}
            spellCheck={false}
            className="flex-grow font-mono text-xs p-3 outline-none resize-none bg-slate-50"
          />
          {(fullParse.errors.length > 0 || (fullParse.infos?.length ?? 0) > 0) && (
            <div className="border-t border-rose-200 bg-rose-50 text-rose-700 text-xs p-2 max-h-40 overflow-y-auto space-y-1">
              {(fullParse.infos ?? []).map((msg, i) => (
                <div
                  key={`info-${i}`}
                  className="font-mono text-sky-900 bg-sky-50 border border-sky-200 rounded px-1.5 py-0.5"
                >
                  {msg}
                </div>
              ))}
              {fullParse.errors.map((e, i) => (
                <div key={i} className="font-mono">
                  {e}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-grow flex flex-col gap-2 min-h-0">
          <div className="flex-grow bg-white rounded-lg shadow-md overflow-hidden min-h-[200px]">
            <svg
              ref={svgRef}
              viewBox={`${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}`}
              className="w-full h-full touch-none select-none"
              onPointerMove={onPointerMove}
              onPointerUp={() => setDrag(null)}
              onPointerLeave={() => setDrag(null)}
            >
              <rect
                x={viewBox.minX + 1}
                y={viewBox.minY + 1}
                width={viewBox.width - 2}
                height={viewBox.height - 2}
                fill="none"
                stroke="#94a3b8"
                strokeWidth={1.5}
                strokeDasharray="7 5"
                pointerEvents="none"
              />
              <g key={`scene-anim-${script.length}-${layoutRerollNonce}-${stepThrough}-${appliedSteps}-${drawAnimation ? 1 : 0}-${drawSegmentMs}`}>
                {sceneNode}
              </g>
              <g className="no-draw-animate">{miniPreviewNode}</g>
              {stepThrough &&
                nextStepPreview &&
                renderStepThroughHelperOverlays(
                  displayFigure,
                  nextStepPreview,
                  helperKey
                )}
              {showDragHandles &&
                (!drawAnimation ||
                  stepThrough ||
                  drawAppliedSteps >= (animatedSteps?.length ?? 0)) &&
                handles.map((h) => (
                  <circle
                    key={h.name}
                    cx={h.x}
                    cy={h.y}
                    r={11}
                    fill="white"
                    stroke="#0f172a"
                    strokeWidth={2}
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => {
                      (e.target as Element).setPointerCapture(e.pointerId);
                      setDrag(h.name);
                    }}
                  />
                ))}
            </svg>
          </div>

          {stepThrough && (
            <div className="shrink-0 bg-white rounded-lg shadow-md border border-slate-200 flex flex-col max-h-56">
              <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between gap-2">
                <span className="text-xs font-bold text-slate-700 uppercase tracking-wide">
                  Build log
                </span>
                <button
                  type="button"
                  disabled={!steps?.length || appliedSteps >= (steps?.length ?? 0)}
                  onClick={advanceStep}
                  className="text-xs font-semibold px-3 py-1 rounded bg-slate-800 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-slate-700"
                >
                  Next step (Enter)
                </button>
                <button
                  type="button"
                  onClick={() => setBuildLog([BUILD_LOG_INTRO])}
                  title="Remove log lines (keeps the intro tip)"
                  className="text-xs font-semibold px-2 py-1 rounded border border-slate-300 hover:bg-slate-100 bg-white text-slate-700"
                >
                  Clear log
                </button>
              </div>
              <div className="px-3 py-2 text-xs text-slate-600 border-b border-slate-50 bg-slate-50/80 max-h-28 overflow-y-auto font-mono leading-snug">
                {nextStepPreview ? (
                  <>
                    <div className="text-slate-500 mb-1">
                      <span className="font-semibold text-slate-600">
                        EXECUTING SCRIPT LINE {nextStepPreview.lineNum}:
                      </span>
                      <span className="block text-slate-800 mt-0.5 break-words">
                        {nextStepPreview.sourceLine.trimEnd() ||
                          "(blank or comment-only — this step is part of the same script line)"}
                      </span>
                    </div>
                    <span className="font-semibold text-amber-800">Next build step: </span>
                    <span className="text-slate-800 whitespace-pre-wrap">
                      {nextStepPreview.message}
                    </span>
                    <span className="text-slate-400">
                      {" "}
                      — macro step {appliedSteps + 1}/{steps?.length ?? 0} for that line
                    </span>
                  </>
                ) : (
                  <span className="text-emerald-700 font-semibold">
                    All steps applied. Turn off “Step-through” to edit normally or
                    change the script to rebuild.
                  </span>
                )}
              </div>
              <div className="px-3 py-2 text-xs font-mono text-slate-700 overflow-y-auto flex-1 min-h-0 max-h-32 space-y-1">
                {buildLog.map((line, i) => (
                  <div
                    key={`${buildLog.length}-${i}-${line.slice(0, 40)}`}
                    className="whitespace-pre-wrap break-words border-b border-slate-100 last:border-0 pb-1 last:pb-0"
                  >
                    {line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="text-xs text-slate-500 mt-2">
        Canvas/frame size: <code>{CANVAS_WIDTH}</code> × <code>{CANVAS_HEIGHT}</code> px.
        The dashed rectangle shows this exact extent.
        {" "}
        Edit the script on the left to change the figure. Drag any draggable handle
        (explicit <code>point</code>, <code>perp</code> labels, or an inferred nest apex
        such as <code>T1c</code>); coordinates are written back into the script (nest
        apex first drag splits into <code>point</code> + explicit <code>nest</code>).
        With <strong>Step-through</strong>, the canvas shows progress after each step;
        the build panel shows the <strong>EXECUTING SCRIPT LINE</strong> (source text)
        and which macro sub-step is next. Press <kbd className="px-1 rounded bg-slate-200">Enter</kbd>{" "}
        (when the script editor is not focused) or click <strong>Next step</strong>.
        <strong>Builder overlays</strong> adds macro helper dots + names; leave it off for
        strokes/fills only. <strong>Script dots</strong> toggles <code>dot</code>/<code>markers</code>.
        <strong>Drag handles</strong> toggles the white drag rings (drawing-only when all three are off).
        <strong>New random layout</strong> re-seeds <code>perp</code>, nest apex, and <code>spike</code>
        randomness without editing the script (stored in <code>sessionStorage</code> until Reset
        or <strong>Reload figure.txt</strong>). A normal tab refresh keeps that reroll.
        Edit <code>public/figure.txt</code> in the repo (dev: served as <code>/figure.txt</code>
        — ignore <code>dist/</code> until you run <code>npm run build</code>). A normal
        browser refresh keeps your script from <code>localStorage</code> (
        <code>{STORAGE_KEY}</code>); click <strong>Reload figure.txt</strong> to fetch
        the file again from the server and apply it.
      </p>
    </div>
  );
};

export default GeometryCanvas;

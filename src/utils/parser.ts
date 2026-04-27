import {
  crossProdZ,
  distance,
  footOnLineThrough,
  formatNestApexSwapRationale,
  nestApexChordHandednessMetrics,
  nestApexShouldSwapEdgeModes,
  perpControl,
  signTowards,
  type NestSwapRuleInfo,
  type Point,
} from "./geometry";
import {
  Dot,
  Figure,
  Region,
  type FigureLayoutCheckpoint,
  type RegionSeg,
  type Style,
} from "./shapes";

/**
 * Tiny text DSL for building a Figure.
 *
 *   const NAME VALUE                  # numeric constant, usable below
 *   const averageSize N               # typical chord / layout scale in px
 *                                      # (default 160). Used as the center for
 *                                      # `perp` perpendicular offset (unless
 *                                      # overridden) and for `topDisplacement`.
 *   const averageSpan P               # percent half-width around centers
 *                                      # (default 20 => uniform in
 *                                      # [(1-P/100)*center, (1+P/100)*center]).
 *                                      # Used with `averageSize` for `perp`
 *                                      # height along the perpendicular from
 *                                      # the chord midpoint.
 *   const tubeAverageHeight H         # nominal tube spike length in px
 *                                      # (default 0.55 * averageSize if unset).
 *   const tubeAverageSpan P           # percent band around tubeAverageHeight
 *                                      # for each spike tip (default 20).
 *   const topDisplacement P           # max parallel slide along the host chord
 *                                      # for `perp` / nest apex: offset in px is uniform in
 *                                      # [-P/100 * averageSize, +P/100 * averageSize]
 *                                      # (default 25). RNG is stable per point name unless
 *                                      # the host app passes randomLayoutNonce (see UI
 *                                      # “New random layout”).
 *   Legacy: if BOTH `tubeHeightLow` and `tubeHeightHigh` are set, `spike`
 *   and the perpendicular part of `perp` use a uniform random distance in
 *   that interval instead of the tubeAverage* / averageSize bands.
 *   const nestContinuations N         # optional. After each `myShape`, run **N batch
 *                                      # passes**: pass 1 nests **every** `T*a`/`T*b`
 *                                      # pair from that shape’s **in** edges; pass 2
 *                                      # nests **every** pair minted during pass 1; etc.
 *                                      # Stops early if a pass has no pairs. Within a pass,
 *                                      # order is the wave queue (e.g. T1 then T2 for
 *                                      # `out in in`); pairs created in that pass wait for
 *                                      # the **next** pass (breadth-by-layer, not depth-
 *                                      # first). Alias: `const continuations`. Default 0.
 *                                      # Put **before** `myShape` so the limit is known
 *                                      # when edges emit.
 *   const nestLayoutMaxAttempts N     # optional. Per inferred `nest` / auto-nest: max
 *                                      # apex re-picks when the proposed apex lands
 *                                      # inside an already-filled region (tube/spike area).
 *                                      # Default **12**. Emits soft {@link ParseResult.infos}
 *                                      # lines for retries / skipped branches.
 *   const continuationEndArrow 0|1    # optional. When **1** (default), the **last**
 *                                      # continuation pass (requires nestContinuations ≥ 2)
 *                                      # draws the two new sides as **rim-only** arcs
 *                                      # toward the new centroid — **no** blade, spike,
 *                                      # or tube tops (an “arrow” tip). Earlier passes stay
 *                                      # full. Set **0** to keep full tubes on every pass.
 *   point NAME X Y                    # absolute point (draggable)
 *   lerp  NAME FROM TO T              # NAME = FROM + T * (TO - FROM)
 *   arc   FROM TO BEND                # signed bend, no reference
 *   arc   FROM TO in|out REF BEND     # bend toward/away from REF
 *   blade FROM TO IN1 IN2 in|out REF  # outer arc + paired inner arc
 *                                      # uses bigBend / smallBend / distance
 *                                      # (defaults: 0.22 / 0.16 / 0.20)
 *   const tubeBend B                  # side legs of each tube/spike (arcs from
 *                                      # inner chord points F,G toward tips X,Y;
 *                                      # default 0.06). Cap still uses smallBend.
 *   tube  P1 P2 Q1 Q2 in|out REF      # two side arcs P1->Q1, P2->Q2 in the
 *                                      # given direction (bend = tubeBend) plus
 *                                      # a cap arc Q1->Q2 (bend = smallBend). The
 *                                      # interior is filled opaque, hiding
 *                                      # any earlier strokes lying inside.
 *   spike P1 P2 Q1 Q2 in|out REF      # like `tube`, but Q1, Q2 are computed
 *                                      # automatically: each is placed along the
 *                                      # perpendicular to the P1-P2 chord, on the
 *                                      # side picked by in|out REF, at a per-side
 *                                      # random distance: legacy fixed range
 *                                      # if both tubeHeightLow and tubeHeightHigh
 *                                      # are set; else each tip in the band
 *                                      # around tubeAverageHeight ± tubeAverageSpan%.
 *                                      # Randomness is
 *                                      # seeded by "Q1|Q2" so it stays stable
 *                                      # across edits.
 *   myShape P1 P2 P3 d12 d13 d23      # "thorny triangle": for each edge, in
 *                                      # the order P1-P2, P1-P3, P2-P3, dij
 *                                      # describes whether the edge has an
 *                                      # inward feature ("in") or is plain
 *                                      # ("out"):
 *                                      #   out -> just one outward arc on the
 *                                      #          edge (bowing away from the
 *                                      #          centroid of P1,P2,P3).
 *                                      #   in  -> outward arc + inward blade
 *                                      #          (outer + inner arcs both
 *                                      #          curving toward the centroid)
 *                                      #          + an outward opaque spike
 *                                      #          extruded from the inner pair,
 *                                      #          which clips the outward arc.
 *                                      #          For each "in" edge, the
 *                                      #          macro also marks two
 *                                      #          "next-triangle" anchor points
 *                                      #          (Tia, Tib) on the same line
 *                                      #          as the tube's top, positioned
 *                                      #          so a follow-up shape using
 *                                      #          the same `distance` constant
 *                                      #          has its tube's bottom land
 *                                      #          exactly on this tube's top.
 *                                      # All helper points are private; their
 *                                      # names start with `_ms`.
 *   perp NAME P1 P2 awayFrom REF      # Place NAME at the midpoint of the
 *                                      # P1-P2 chord, offset perpendicularly
 *                                      # by a seeded-random distance along the
 *                                      # perpendicular through the chord midpoint
 *                                      # (band: averageSize ± averageSpan%), on
 *                                      # the side AWAY from REF, then shifted
 *                                      # along the chord direction by up to
 *                                      # ±(topDisplacement% of averageSize).
 *                                      # NAME is registered as
 *                                      # a draggable free point: as soon as
 *                                      # you drag it the `perp` line is
 *                                      # rewritten to a literal `point NAME
 *                                      # X Y`, so further drags behave like
 *                                      # any other free point.
 *   nest P1 P2                         # Stack on anchors P1–P2 (e.g. T1a T1b).
 *                                      # Infers apex (…a + …b → …c). If P1/P2 were
 *                                      # minted as next-triangle anchors on an `in`
 *                                      # edge, apex is placed **away from that edge's
 *                                      # triangle body** (same geometry as the tube
 *                                      # opening — same bands as `perp`). Otherwise
 *                                      # falls back to a seeded random L/R pick.
 *                                      # First canvas drag on that apex rewrites to
 *                                      # `point …c` + `nest P1 P2 …c d13 d23` (same chirality).
 *   nest P1 P2 REF                     # Same inferred apex, but **away from** REF
 *                                      # explicitly (same rule as `perp … awayFrom`).
 *                                      # Use when anchors are not auto-registered or
 *                                      # you want a different body ref than the host.
 *                                      # Then auto `in`/`out` on the two new sides
 *                                      # (foot on chord: `in` on the anchor **closer** to the
 *                                      # apex projection; else host-cross / dot fallback).
 *                                      # First drag on the apex rewrites to `point …c`
 *                                      # plus the eight-token `nest … awayFrom …` form.
 *   nest P1 P2 P3 d13 d23              # Variant of myShape that stacks on top
 *                                      # of an existing tube. P1, P2 are
 *                                      # already-defined anchor points (e.g.
 *                                      # the T1a/T1b a previous `myShape`
 *                                      # produced); P3 must also already be
 *                                      # defined (use `perp` to create it
 *                                      # quickly, or define it by hand with
 *                                      # `point`). Edge P1-P2 is redrawn last as a
 *                                      # Shared chord P1–P2 gets **two** bigBend-scale
 *                                      # arcs (no blade/spike), always **opposite signed
 *                                      # bends** (second = −first) so they cannot merge
 *                                      # into one curve when host vs new centroid fall
 *                                      # on opposite sides of the chord. Outward from
 *                                      # host body when known is **prepended** under the
 *                                      # figure (tube fill clips overlap); mate appended
 *                                      # after the two new sides. Then the host **opaque
 *                                      # tube interior** is built again (same F→X→Y→G
 *                                      region as the original spike) **on top** so arc
 *                                      strokes inside the tube are hidden.
 *                                      # Only d13 and d23 are specified for
 *                                      # the two new sides P1-P3 and P2-P3.
 *                                      # Chirality: foot-closer rule first; if the foot is
 *                                      # almost centered on the chord, host-centroid cross
 *                                      # vs apex cross, then dot fallback (`geometry.ts`).
 *   nest P1 P2 P3 awayFrom REF d13 d23 # Same as above, but auto-generates P3
 *                                      # via the same rule as `perp` (kept
 *                                      # for one-liner use; the resulting P3
 *                                      # is not draggable until you add `point P3 …`).
 *   line  FROM TO
 *   dot   NAME [NAME ...]            # small dots with text labels (defaults to each name)
 *   markers NAME [NAME ...]         # same dots without labels (cleaner exports)
 *   # any text after `#` is a comment
 *
 * Every numeric slot (X, Y, T, BEND, VALUE) accepts either a literal
 * number or the name of a previously-declared `const`.
 *
 * REF tokens (in `arc`, `blade`, `tube`, `spike`) accept either:
 *   - a single defined point name (`B`)         -> reference IS that point
 *   - a multi-character "body" like `ABC`        -> reference is the centroid
 *     where every single character is a defined    of those points
 *     point name
 * Body refs are the natural way to say "with respect to the *interior* of
 * the figure": e.g. `out ABC` always means "outward from the triangle",
 * regardless of which chord the arc lives on.
 */

/** Gray helper segment between two named points (resolved when the step is shown). */
export type HelperLineSpec = { from: string; to: string };

/** One atomic build action for step-through mode (Enter advances). */
export type BuildStep = {
  lineNum: number;
  /** Raw script line (same index as `lineNum`); multiple steps can share one line. */
  sourceLine: string;
  message: string;
  helperLines?: HelperLineSpec[];
  /** Mutates the given figure (replay uses a fresh `Figure` per run). */
  apply: (f: Figure) => void;
};

/** One `nest P1 P2` / `nest P1 P2 REF` line with inferred apex; used to rewrite the script when that apex is dragged. */
export type ImplicitNestApexInfo = {
  apex: string;
  p1: string;
  p2: string;
  /** Set for the four-token `nest P1 P2 REF` form. */
  awayRef?: string;
  d13: "in" | "out";
  d23: "in" | "out";
  /** 1-based source line (same numbering as parse errors). */
  lineNum: number;
};

export interface ParseResult {
  figure: Figure;
  errors: string[];
  /** Non-fatal notes (e.g. nest apex layout retries). */
  infos?: string[];
  /** Draggable point names: `point`, `perp`, inferred-apex `nest P1 P2` / `nest P1 P2 REF`. */
  freePoints: string[];
  /** Inferred-apex `nest` lines (3- or 4-token); see {@link updatePointInScript}. */
  implicitNestApexes: ImplicitNestApexInfo[];
  /** Present when `parse(..., { stepped: true })`: run each `apply` after Enter. */
  buildSteps?: BuildStep[];
}

export interface ParseOptions {
  /** When true, geometry is built only as `buildSteps` are applied in the UI. */
  stepped?: boolean;
  /**
   * When false, macro-generated **helper dots are omitted entirely** (`_ms…`, body,
   * nest mid/projection, spike tips, `T*a`/`T*b`, green nest apex) — not just labels.
   * Default true.
   */
  showMacroHelperLabels?: boolean;
  /**
   * When false, `dot` / `markers` script lines do not draw anything (strokes/fills only).
   * Default true.
   */
  showScriptDots?: boolean;
  /**
   * When non-empty, mixed into RNG seeds for `perp`, nest apex placement (height +
   * along-chord slide, random-L/R fallback), and `spike` tip lengths so the same script
   * can produce a new layout without renaming points. Default: omit for stable output.
   */
  randomLayoutNonce?: string;
}

const BLADE_DEFAULTS = {
  /** Typical chord / layout scale in px. */
  averageSize: 160,
  /** Percent: random near averageSize uses [(1-P/100)*S, (1+P/100)*S]. */
  averageSpan: 20,
  /** Percent band around `tubeAverageHeight` for spike lengths (see helpers). */
  tubeAverageSpan: 20,
  /** Max parallel offset for `perp`, as percent of `averageSize`. */
  topDisplacement: 25,
  bigBend: 0.22,
  smallBend: 0.16,
  /** Quadratic bend along each tube/spike leg (e.g. `_ms*_F` → `_ms*_X`). */
  tubeBend: 0.06,
  distance: 0.2,
} as const;

/** Background color used to paint the opaque interior of `tube`/`spike`. */
const TUBE_FILL = "white";

// Tiny FNV-ish string hash + mulberry32 PRNG. Used so that `spike` can
// pick a "random" distance that stays stable across re-parses (which
// happen on every keystroke), while still differing per Q1/Q2 pair.
function hashSeed(s: string): number {
  let h = 1779033703 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    h = Math.imul(h ^ s.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same signed bend that `Figure.arc` would use internally for (dir, ref). */
function resolveSignedBend(
  p1: Point,
  p2: Point,
  refPt: Point,
  dir: "in" | "out",
  magnitude: number
): number {
  const sgn = signTowards(p1, p2, refPt);
  const factor = dir === "in" ? sgn : -sgn;
  return factor * Math.abs(magnitude);
}

/**
 * If P1/P2 are paired anchors like `T1a` and `T1b` (same prefix, suffix `a`/`b`),
 * returns the inferred apex label `T1c`. Otherwise `null`.
 */
export function inferNestApexFromAnchors(p1: string, p2: string): string | null {
  if (p1.length < 2 || p2.length < 2) return null;
  const last1 = p1.slice(-1);
  const last2 = p2.slice(-1);
  const pre1 = p1.slice(0, -1);
  const pre2 = p2.slice(0, -1);
  if (pre1 !== pre2) return null;
  const l1 = last1.toLowerCase();
  const l2 = last2.toLowerCase();
  if (l1 !== "a" || l2 !== "b") return null;
  if (last1 === "A" && last2 === "B") return `${pre1}C`;
  return `${pre1}c`;
}

/** Names declared with `point NAME ...` (for draggable handles while stepping). */
function scanFreePointNamesFromScript(script: string): string[] {
  const out: string[] = [];
  for (const line of script.split("\n")) {
    const toks = line.replace(/#.*/, "").trim().split(/\s+/);
    const cmd = toks[0]?.toLowerCase();
    if (cmd === "point" && toks.length >= 2) {
      out.push(toks[1]);
    } else if (cmd === "perp" && toks.length >= 2) {
      out.push(toks[1]);
    } else if (cmd === "nest" && (toks.length === 3 || toks.length === 4)) {
      const apex = inferNestApexFromAnchors(toks[1]!, toks[2]!);
      if (apex) out.push(apex);
    }
  }
  return out;
}

export function parse(
  script: string,
  style?: Style,
  options?: ParseOptions
): ParseResult {
  const errors: string[] = [];
  const infos: string[] = [];
  const freePoints: string[] = [];
  const consts = new Map<string, number>();
  const fig = new Figure();
  const stepped = options?.stepped ?? false;
  const buildSteps: BuildStep[] = [];
  const implicitNestApexes: ImplicitNestApexInfo[] = [];
  const scriptLines = script.split("\n");
  const showMacroHelperLabels = options?.showMacroHelperLabels !== false;
  const showScriptDots = options?.showScriptDots !== false;
  const macroVis = (f: Figure, nm: string) => {
    if (showMacroHelperLabels) f.macroHelperDot(nm);
  };
  const layoutNonce = (options?.randomLayoutNonce ?? "").trim();
  const seedFor = (key: string) =>
    layoutNonce.length > 0
      ? hashSeed(`${layoutNonce}::${key}`)
      : hashSeed(key);
  /** Current script line number (set each iteration before commands run). */
  let scriptLineNum = 0;

  /**
   * Record a build step when stepped, and **always** run `apply(fig)` so the
   * parse-time figure stays consistent for later script lines. The UI replays
   * by applying the first N recorded `apply` closures to a **fresh** figure.
   */
  const pushStep = (
    message: string,
    helperLines: HelperLineSpec[] | undefined,
    apply: (f: Figure) => void
  ) => {
    if (stepped) {
      buildSteps.push({
        lineNum: scriptLineNum,
        sourceLine: scriptLines[scriptLineNum - 1] ?? "",
        message,
        helperLines,
        apply,
      });
    }
    apply(fig);
  };

  // Cache of synthetic centroid points generated from body refs (e.g. "ABC"
  // -> "__body_ABC"). Re-used across multiple references in the same parse.
  const bodyCache = new Map<string, string>();
  let bodyCounter = 0;

  const num = (s: string): number => {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    if (consts.has(s)) return consts.get(s)!;
    throw new Error(`expected number or known constant, got "${s}"`);
  };

  const avgSize = (): number =>
    consts.has("averageSize") ? consts.get("averageSize")! : BLADE_DEFAULTS.averageSize;

  const avgSpanPct = (): number =>
    consts.has("averageSpan") ? consts.get("averageSpan")! : BLADE_DEFAULTS.averageSpan;

  /** Nominal spike length; defaults to 0.55 * averageSize. */
  const tubeHeightCenter = (): number =>
    consts.has("tubeAverageHeight")
      ? consts.get("tubeAverageHeight")!
      : 0.55 * avgSize();

  const tubeSpanPct = (): number =>
    consts.has("tubeAverageSpan")
      ? consts.get("tubeAverageSpan")!
      : BLADE_DEFAULTS.tubeAverageSpan;

  const topDispPct = (): number =>
    consts.has("topDisplacement")
      ? consts.get("topDisplacement")!
      : BLADE_DEFAULTS.topDisplacement;

  /** Uniform random in [center*(1-P/100), center*(1+P/100)] using span P. */
  const spanBand = (
    center: number,
    spanPct: number,
    rng: () => number
  ): number => {
    const lo = center * (1 - spanPct / 100);
    const hi = center * (1 + spanPct / 100);
    return lo + rng() * (hi - lo);
  };

  const randomTubeExtrusion = (rng: () => number): number =>
    spanBand(tubeHeightCenter(), tubeSpanPct(), rng);

  /** Resolve a built-in default or user `const`. */
  const constOr = (name: keyof typeof BLADE_DEFAULTS): number => {
    if (consts.has(name)) return consts.get(name)!;
    return BLADE_DEFAULTS[name];
  };

  /**
   * Max **passes** (batch iterations) of auto-`nest` after each `myShape`; 0 = off.
   * Reads `nestContinuations` or `continuations`.
   */
  const nestContinuationMax = (): number => {
    if (consts.has("nestContinuations")) {
      return Math.max(0, Math.floor(consts.get("nestContinuations")!));
    }
    if (consts.has("continuations")) {
      return Math.max(0, Math.floor(consts.get("continuations")!));
    }
    return 0;
  };

  /**
   * When true, the last auto-continuation pass (if there are ≥2 passes) draws new sides
   * as rim-only “arrow” tips (no blade/tube). Default on; `const continuationEndArrow 0` disables.
   */
  const continuationEndArrow = (): boolean => {
    if (consts.has("continuationEndArrow")) {
      return consts.get("continuationEndArrow")! !== 0;
    }
    return true;
  };

  /** Max apex re-picks per inferred `nest` when apex falls inside a filled area. */
  const nestLayoutMaxAttempts = (): number => {
    if (consts.has("nestLayoutMaxAttempts")) {
      return Math.max(1, Math.floor(consts.get("nestLayoutMaxAttempts")!));
    }
    return 12;
  };

  const parseDir = (raw: string): "in" | "out" => {
    const d = raw.toLowerCase();
    if (d !== "in" && d !== "out") {
      throw new Error(`expected "in" or "out", got "${raw}"`);
    }
    return d;
  };

  /**
   * Resolve a REF token to a point name registered in the figure.
   *
   * - If the token is a defined point, returns it as-is.
   * - Otherwise, treats every character as a single-letter point name and
   *   registers a synthetic point at their centroid (e.g. `ABC` ->
   *   `__body_ABC` at centroid(A, B, C)). Re-uses the same synthetic point
   *   if the same body string appears again.
   */
  const resolveRefOn = (f: Figure, token: string): string => {
    if (f.has(token)) return token;
    if (bodyCache.has(token)) {
      const synth = bodyCache.get(token)!;
      if (f.has(synth)) return synth;
      const parts = token.split("");
      if (parts.length >= 2 && parts.every((c) => f.has(c))) {
        const pts = parts.map((c) => f.pt(c));
        const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
        const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
        f.point(synth, { x: cx, y: cy });
        return synth;
      }
    }
    const parts = token.split("");
    if (parts.length >= 2 && parts.every((c) => f.has(c))) {
      const pts = parts.map((c) => f.pt(c));
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      const synth = `__body_${token}_${bodyCounter++}`;
      f.point(synth, { x: cx, y: cy });
      bodyCache.set(token, synth);
      return synth;
    }
    throw new Error(`unknown point or body "${token}"`);
  };

  /** blade body (without the usage check): outer arc + inner arc through F, G. */
  const emitBlade = (
    from: string,
    to: string,
    in1: string,
    in2: string,
    dir: "in" | "out",
    refTok: string
  ) => {
    const big = constOr("bigBend");
    const small = constOr("smallBend");
    const d = constOr("distance");
    pushStep(
      `Blade: outer arc ${from}→${to} (bigBend=${big}, dir=${dir}, ref=${refTok})`,
      [{ from, to }],
      (f) => {
        f.arc(from, to, {
          bend: big,
          dir,
          ref: resolveRefOn(f, refTok),
          style,
        });
      }
    );
    pushStep(
      `Blade: inner anchors — ${in1} = lerp(${from},${to}, ${d}), ${in2} = lerp(${from},${to}, ${(1 - d).toFixed(2)})  (distance const = ${d})`,
      [{ from, to }],
      (f) => {
        f.lerpPoint(in1, from, to, d);
        f.lerpPoint(in2, from, to, 1 - d);
        macroVis(f, in1);
        macroVis(f, in2);
      }
    );
    pushStep(
      `Blade: inner arc ${in1}→${in2} (smallBend=${small}, dir=${dir})`,
      [{ from: in1, to: in2 }],
      (f) => {
        f.arc(in1, in2, {
          bend: small,
          dir,
          ref: resolveRefOn(f, refTok),
          style,
        });
      }
    );
  };

  /**
   * Unit normal used to offset spike tips from P1/P2, matching `spike` /
   * `emitSpike` geometry.
   */
  const spikeOutwardNormal = (
    P1: Point,
    P2: Point,
    R: Point,
    dir: "in" | "out"
  ): { nx: number; ny: number } => {
    const dx = P2.x - P1.x;
    const dy = P2.y - P1.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    const mx = (P1.x + P2.x) / 2;
    const my = (P1.y + P2.y) / 2;
    const towardRef = nx * (R.x - mx) + ny * (R.y - my);
    const wantTowardRef = dir === "in";
    if ((towardRef > 0) !== wantTowardRef) {
      nx = -nx;
      ny = -ny;
    }
    return { nx, ny };
  };

  /**
   * Opaque interior of a tube/spike (must be drawn before boundary arcs).
   */
  const emitTubeRegionOnly = (
    target: Figure,
    p1: string,
    p2: string,
    q1: string,
    q2: string,
    dir: "in" | "out",
    refName: string
  ) => {
    const leg = constOr("tubeBend");
    const small = constOr("smallBend");
    const cap: "in" | "out" = dir;

    const P1 = target.pt(p1);
    const P2 = target.pt(p2);
    const Q1 = target.pt(q1);
    const Q2 = target.pt(q2);
    const R = target.pt(refName);

    const sb1 = resolveSignedBend(P1, Q1, R, dir, leg);
    const sb2 = resolveSignedBend(P2, Q2, R, dir, leg);
    const sbCap = resolveSignedBend(Q1, Q2, R, cap, small);

    const ctrl1 = perpControl(P1, Q1, sb1);
    const ctrl2 = perpControl(P2, Q2, sb2);
    const ctrlCap = perpControl(Q1, Q2, sbCap);

    const segs: RegionSeg[] = [
      { kind: "quad", ctrl: ctrl1, to: Q1 },
      { kind: "quad", ctrl: ctrlCap, to: Q2 },
      { kind: "quad", ctrl: ctrl2, to: P2 },
    ];
    target.add(new Region(P1, segs, TUBE_FILL));
  };

  const emitTubeArcP1Q1 = (
    target: Figure,
    p1: string,
    q1: string,
    dir: "in" | "out",
    refName: string
  ) => {
    const tb = constOr("tubeBend");
    target.arc(p1, q1, { bend: tb, dir, ref: refName, style });
  };

  const emitTubeArcP2Q2 = (
    target: Figure,
    p2: string,
    q2: string,
    dir: "in" | "out",
    refName: string
  ) => {
    const tb = constOr("tubeBend");
    target.arc(p2, q2, { bend: tb, dir, ref: refName, style });
  };

  const emitTubeCapQ1Q2 = (
    target: Figure,
    q1: string,
    q2: string,
    dir: "in" | "out",
    refName: string
  ) => {
    const small = constOr("smallBend");
    target.arc(q1, q2, { bend: small, dir, ref: refName, style });
  };

  /**
   * Place Q1 (from P1) and Q2 (from P2) along the perpendicular to the
   * P1-P2 chord, then emit a tube on top. Mirrors what the `spike`
   * command does standalone, but as a helper callable from other macros.
   */
  const emitSpike = (
    p1: string,
    p2: string,
    q1: string,
    q2: string,
    dir: "in" | "out",
    refToken: string
  ) => {
    const rng = mulberry32(seedFor(`${q1}|${q2}`));
    let d1: number;
    let d2: number;
    if (consts.has("tubeHeightLow") && consts.has("tubeHeightHigh")) {
      const lo = consts.get("tubeHeightLow")!;
      const hi = consts.get("tubeHeightHigh")!;
      d1 = lo + rng() * (hi - lo);
      d2 = lo + rng() * (hi - lo);
    } else {
      d1 = randomTubeExtrusion(rng);
      d2 = randomTubeExtrusion(rng);
    }

    pushStep(
      `Spike: resolve ref “${refToken}” (bend reference for chord ${p1}–${p2}, ${dir})`,
      [{ from: p1, to: p2 }],
      (f) => {
        resolveRefOn(f, refToken);
      }
    );

    pushStep(
      `Spike: place tip ${q1} — along ⊥ from ${p1}, offset ${d1.toFixed(1)} px (seed ${q1}|${q2})`,
      [{ from: p1, to: p2 }],
      (f) => {
        const refNm = resolveRefOn(f, refToken);
        const P1 = f.pt(p1);
        const P2 = f.pt(p2);
        const R = f.pt(refNm);
        const { nx, ny } = spikeOutwardNormal(P1, P2, R, dir);
        f.point(q1, { x: P1.x + nx * d1, y: P1.y + ny * d1 });
        macroVis(f, q1);
      }
    );

    pushStep(
      `Spike: place tip ${q2} — along ⊥ from ${p2}, offset ${d2.toFixed(1)} px`,
      [{ from: p1, to: p2 }, { from: p1, to: q1 }],
      (f) => {
        const refNm = resolveRefOn(f, refToken);
        const P1 = f.pt(p1);
        const P2 = f.pt(p2);
        const R = f.pt(refNm);
        const { nx, ny } = spikeOutwardNormal(P1, P2, R, dir);
        f.point(q2, { x: P2.x + nx * d2, y: P2.y + ny * d2 });
        macroVis(f, q2);
      }
    );

    pushStep(
      `Tube: opaque interior (${p1}→${q1}→${q2}→${p2} closed)`,
      [
        { from: p1, to: q1 },
        { from: q1, to: q2 },
        { from: q2, to: p2 },
      ],
      (f) => {
        const refNm = resolveRefOn(f, refToken);
        emitTubeRegionOnly(f, p1, p2, q1, q2, dir, refNm);
      }
    );

    pushStep(
      `Tube: side arc ${p1}→${q1}`,
      [{ from: p1, to: q1 }],
      (f) => {
        const refNm = resolveRefOn(f, refToken);
        emitTubeArcP1Q1(f, p1, q1, dir, refNm);
      }
    );

    pushStep(
      `Tube: side arc ${p2}→${q2}`,
      [{ from: p2, to: q2 }],
      (f) => {
        const refNm = resolveRefOn(f, refToken);
        emitTubeArcP2Q2(f, p2, q2, dir, refNm);
      }
    );

    pushStep(
      `Tube: cap arc ${q1}→${q2} (smallBend)`,
      [{ from: q1, to: q2 }],
      (f) => {
        const refNm = resolveRefOn(f, refToken);
        emitTubeCapQ1Q2(f, q1, q2, dir, refNm);
      }
    );
  };

  /**
   * Place `name` near the chord P1–P2: perpendicular offset from the midpoint
   * (away from `refName`) with length in the averageSize ± averageSpan% band,
   * then a random parallel shift along the chord by at most
   * (topDisplacement% of averageSize). Seeded by `name`.
   */
  const placePerpAwayFrom = (
    name: string,
    p1: string,
    p2: string,
    refToken: string,
    stepKind: "perp" | "nest" = "perp"
  ) => {
    const stepMsg =
      stepKind === "nest"
        ? `nest: place apex ${name} — ⊥ from ${p1}–${p2} midpoint away from host body (${refToken}), same bands as perp`
        : `perp ${name}: from chord ${p1}–${p2} midpoint, offset ⊥ by averageSize±averageSpan%, then parallel slide ≤ ${topDispPct()}% of averageSize along chord (away from ref ${refToken})`;
    pushStep(stepMsg, [{ from: p1, to: p2 }], (f) => {
        const refNm = resolveRefOn(f, refToken);
        const P1 = f.pt(p1);
        const P2 = f.pt(p2);
        const R = f.pt(refNm);
        const dx = P2.x - P1.x;
        const dy = P2.y - P1.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        let nx = -dy / len;
        let ny = dx / len;
        const mx = (P1.x + P2.x) / 2;
        const my = (P1.y + P2.y) / 2;
        const towardRef = nx * (R.x - mx) + ny * (R.y - my);
        if (towardRef > 0) {
          nx = -nx;
          ny = -ny;
        }
        const rng = mulberry32(seedFor(name));
        let h: number;
        if (consts.has("tubeHeightLow") && consts.has("tubeHeightHigh")) {
          const lo = consts.get("tubeHeightLow")!;
          const hi = consts.get("tubeHeightHigh")!;
          h = lo + rng() * (hi - lo);
        } else {
          h = spanBand(avgSize(), avgSpanPct(), rng);
        }
        const maxPar = (topDispPct() / 100) * avgSize();
        const t = (2 * rng() - 1) * maxPar;
        f.point(name, {
          x: mx + nx * h + ux * t,
          y: my + ny * h + uy * t,
        });
    });
  };

  /**
   * Fallback when `nest P1 P2` anchors are not registered (not from our `Tia`/`Tib`
   * minting): random L/R ⊥, same distance and parallel-slide bands as `perp`.
   */
  const placeNestApexRandomLr = (name: string, p1: string, p2: string) => {
    pushStep(
      `nest: place apex ${name} — random L/R ⊥ from ${p1}–${p2} midpoint (anchors had no host body; same bands as perp)`,
      [{ from: p1, to: p2 }],
      (f) => {
        const P1 = f.pt(p1);
        const P2 = f.pt(p2);
        const dx = P2.x - P1.x;
        const dy = P2.y - P1.y;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        let nx = -dy / len;
        let ny = dx / len;
        const mx = (P1.x + P2.x) / 2;
        const my = (P1.y + P2.y) / 2;
        const rng = mulberry32(seedFor(`${name}|${p1}|${p2}|nestLR`));
        if (rng() < 0.5) {
          nx = -nx;
          ny = -ny;
        }
        let h: number;
        if (consts.has("tubeHeightLow") && consts.has("tubeHeightHigh")) {
          const lo = consts.get("tubeHeightLow")!;
          const hi = consts.get("tubeHeightHigh")!;
          h = lo + rng() * (hi - lo);
        } else {
          h = spanBand(avgSize(), avgSpanPct(), rng);
        }
        const maxPar = (topDispPct() / 100) * avgSize();
        const t = (2 * rng() - 1) * maxPar;
        f.point(name, {
          x: mx + nx * h + ux * t,
          y: my + ny * h + uy * t,
        });
      }
    );
  };

  /** Same geometry as {@link placeNestApexRandomLr} `apply`, without `pushStep` (nest layout retries). */
  const computeNestApexRandomLrOnFigure = (
    f: Figure,
    name: string,
    p1: string,
    p2: string,
    tryIdx: number
  ) => {
    const P1 = f.pt(p1);
    const P2 = f.pt(p2);
    const dx = P2.x - P1.x;
    const dy = P2.y - P1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    let nx = -dy / len;
    let ny = dx / len;
    const mx = (P1.x + P2.x) / 2;
    const my = (P1.y + P2.y) / 2;
    const seedKey =
      tryIdx === 0
        ? `${name}|${p1}|${p2}|nestLR`
        : `${name}|${p1}|${p2}|nestLR|try${tryIdx}`;
    const rng = mulberry32(seedFor(seedKey));
    if (rng() < 0.5) {
      nx = -nx;
      ny = -ny;
    }
    let h: number;
    if (consts.has("tubeHeightLow") && consts.has("tubeHeightHigh")) {
      const lo = consts.get("tubeHeightLow")!;
      const hi = consts.get("tubeHeightHigh")!;
      h = lo + rng() * (hi - lo);
    } else {
      h = spanBand(avgSize(), avgSpanPct(), rng);
    }
    const maxPar = (topDispPct() / 100) * avgSize();
    const t = (2 * rng() - 1) * maxPar;
    f.point(name, {
      x: mx + nx * h + ux * t,
      y: my + ny * h + uy * t,
    });
  };

  /** Same geometry as nest `placePerpAwayFrom` `apply`, without `pushStep` (nest layout retries). */
  const computeNestPerpAwayFromOnFigure = (
    f: Figure,
    name: string,
    p1: string,
    p2: string,
    refToken: string,
    tryIdx: number
  ) => {
    const refNm = resolveRefOn(f, refToken);
    const P1 = f.pt(p1);
    const P2 = f.pt(p2);
    const R = f.pt(refNm);
    const dx = P2.x - P1.x;
    const dy = P2.y - P1.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    let nx = -dy / len;
    let ny = dx / len;
    const mx = (P1.x + P2.x) / 2;
    const my = (P1.y + P2.y) / 2;
    const towardRef = nx * (R.x - mx) + ny * (R.y - my);
    if (towardRef > 0) {
      nx = -nx;
      ny = -ny;
    }
    const seedKey = tryIdx === 0 ? name : `${name}|try${tryIdx}`;
    const rng = mulberry32(seedFor(seedKey));
    let h: number;
    if (consts.has("tubeHeightLow") && consts.has("tubeHeightHigh")) {
      const lo = consts.get("tubeHeightLow")!;
      const hi = consts.get("tubeHeightHigh")!;
      h = lo + rng() * (hi - lo);
    } else {
      h = spanBand(avgSize(), avgSpanPct(), rng);
    }
    const maxPar = (topDispPct() / 100) * avgSize();
    const t = (2 * rng() - 1) * maxPar;
    f.point(name, {
      x: mx + nx * h + ux * t,
      y: my + ny * h + uy * t,
    });
  };

  /** Counter so `myShape` / `nest` can mint unique helper-point names per call. */
  let shapeCounter = 0;
  /**
   * Globally unique index for next-triangle anchor labels (T1a/T1b, T2a/T2b,
   * ...). Shared across all `myShape` and `nest` calls so labels never
   * collide visually.
   */
  let nextTriCounter = 0;

  /**
   * `Tia` / `Tib` from `emitShapeEdge` → that edge's triangle centroid point
   * (`_ms…_body`). Used so `nest Tia Tib` offsets the apex away from the **local**
   * host body (tube opening), not e.g. the outer `ABC` when chaining nests.
   */
  const nestAnchorHostBody = new Map<string, string>();

  /**
   * For `Tia`/`Tib` on an `in` edge: F,G,X,Y + spike dir/ref so `nest` can re-run
   * `emitTubeRegionOnly` after shared-base arcs and paint white **on top** where the
   * tube should hide arc strokes (same geometry as the original opaque interior).
   */
  const nestAnchorHostTubeReplay = new Map<
    string,
    {
      p1: string;
      p2: string;
      q1: string;
      q2: string;
      dir: "in" | "out";
      refPointName: string;
    }
  >();

  /**
   * `T*a`/`T*b` pairs minted on **in** edges (when {@link nestContinuationMax} > 0 at emit time).
   * After `myShape`, drained into per-pass **waves** for automatic `nest`-equivalent
   * geometry. While a pass runs, new pairs are routed to the next wave via
   * {@link continuationAnchorSink}.
   */
  const pendingInAnchors: { p1: string; p2: string }[] = [];

  /** When set, `emitShapeEdge` `in`-edge anchor pairs go here instead of `pendingInAnchors`. */
  let continuationAnchorSink: ((pair: { p1: string; p2: string }) => void) | null =
    null;

  /**
   * `nest` chirality: put blade (`in`) on **p1–p3** when `swap` is true.
   * Primary rule: apex projection onto chord **p1–p2** is closer to **p1** or **p2**;
   * put `in` on that anchor’s edge to **p3** (swap default out/in when **p1** is closer).
   * If the foot is almost equidistant to **p1** and **p2**, fall back to
   * **crossZ(anchorChord, hostBody)** vs **crossZ(anchorChord, apex)**, then dot heuristic.
   */
  const resolveNestSideSwap = (
    p1n: string,
    p2n: string,
    p3n: string,
    targetFig: Figure
  ): { swap: boolean; swapRule: NestSwapRuleInfo } => {
    const Pa = targetFig.pt(p1n);
    const Pb = targetFig.pt(p2n);
    const Pc = targetFig.pt(p3n);
    const chordLen = distance(Pa, Pb) || 1;
    const foot = footOnLineThrough(Pa, Pb, Pc);
    const distP1Foot = distance(foot, Pa);
    const distP2Foot = distance(foot, Pb);
    const footTieAbs = Math.max(1e-5, 1e-4 * chordLen);
    if (Math.abs(distP1Foot - distP2Foot) > footTieAbs) {
      const p1Closer = distP1Foot < distP2Foot;
      return {
        swap: p1Closer,
        swapRule: {
          kind: "footCloser",
          distP1Foot,
          distP2Foot,
          closerToFoot: p1Closer ? "p1" : "p2",
        },
      };
    }

    const hostB =
      nestAnchorHostBody.get(p1n) ?? nestAnchorHostBody.get(p2n);
    const crossApex = crossProdZ(Pa, Pb, Pc);
    if (
      hostB &&
      targetFig.has(hostB) &&
      targetFig.has(p3n) &&
      Math.abs(crossApex) > 1e-5
    ) {
      const crossHost = crossProdZ(Pa, Pb, targetFig.pt(hostB));
      if (Math.abs(crossHost) > 1e-5) {
        const swap = crossHost * crossApex < 0;
        return {
          swap,
          swapRule: {
            kind: "hostBodyCross",
            hostBody: hostB,
            crossHost,
            crossApex,
          },
        };
      }
    }
    const swap = nestApexShouldSwapEdgeModes(Pa, Pb, Pc);
    const m = nestApexChordHandednessMetrics(Pa, Pb, Pc);
    return {
      swap,
      swapRule: { kind: "dotFallback", dotFallback: m.dotChordVsViewRight },
    };
  };

  /**
   * Emit a single edge of a "thorny triangle" shape:
   *   - always: a **rim** arc <a>-<b> bulging **away from** triangle centroid `bodyName`
   *     (Figure `arc` dir=out ref=body — not the same as script token `out`/`in`).
   *   - if mode === "in": also a blade (outer + inner inward arcs) and an
   *     opaque outward spike, plus the two next-triangle anchor points
   *     (Tia, Tib) on the same line as the spike's top, suitable for
   *     chaining a follow-up shape on top of this tube.
   *
   * `id` and `suf` together yield unique private names for F/G/X/Y/Ta/Tb.
   * `k` is the chord-extension factor d/(1-2d) computed once by the caller.
   */
  const emitShapeEdge = (
    id: number,
    a: string,
    b: string,
    mode: "in" | "out",
    suf: string,
    bodyName: string,
    k: number,
    opts?: { skipAnchors?: boolean }
  ) => {
    const big = constOr("bigBend");
    const rimNote =
      mode === "in"
        ? `Rim arc (bigBend=${big}): bulges **away from** triangle centroid ${bodyName} (arc dir=out, ref=body — not the same as edge token \`out\`). Edge mode **in** → next steps add blade + opaque tube on this side.`
        : `Rim arc only (bigBend=${big}, away from ${bodyName}); edge mode **out** → no blade/tube.`;
    pushStep(`Shape edge ${a}–${b}: ${rimNote}`, [{ from: a, to: b }], (f) => {
      f.arc(a, b, { bend: big, dir: "out", ref: bodyName, style });
    });

    if (mode !== "in") return;

    const F = `_ms${id}_F${suf}`;
    const G = `_ms${id}_G${suf}`;
    const X = `_ms${id}_X${suf}`;
    const Y = `_ms${id}_Y${suf}`;
    emitBlade(a, b, F, G, "in", bodyName);
    emitSpike(F, G, X, Y, "out", bodyName);

    if (opts?.skipAnchors) return;

    const tubeReplay = {
      p1: F,
      p2: G,
      q1: X,
      q2: Y,
      dir: "out" as const,
      refPointName: bodyName,
    };

    nextTriCounter += 1;
    const triIdx = nextTriCounter;
    const triPair = { p1: `T${triIdx}a`, p2: `T${triIdx}b` };
    if (continuationAnchorSink) {
      continuationAnchorSink(triPair);
    } else if (nestContinuationMax() > 0) {
      pendingInAnchors.push(triPair);
    }
    pushStep(
      `Next-triangle anchors on tube top ${X}–${Y} (extension k = d/(1−2d) = ${k.toFixed(3)})`,
      [{ from: X, to: Y }],
      (f) => {
        const Xp = f.pt(X);
        const Yp = f.pt(Y);
        const dx = Yp.x - Xp.x;
        const dy = Yp.y - Xp.y;
        const TaName = `T${triIdx}a`;
        const TbName = `T${triIdx}b`;
        f.point(TaName, { x: Xp.x - k * dx, y: Xp.y - k * dy });
        f.point(TbName, { x: Yp.x + k * dx, y: Yp.y + k * dy });
        nestAnchorHostBody.set(TaName, bodyName);
        nestAnchorHostBody.set(TbName, bodyName);
        nestAnchorHostTubeReplay.set(TaName, tubeReplay);
        nestAnchorHostTubeReplay.set(TbName, tubeReplay);
        if (showMacroHelperLabels) {
          f.add(new Dot(f.pt(TaName), TaName, 5, "#2563eb"));
          f.add(new Dot(f.pt(TbName), TbName, 5, "#2563eb"));
        }
      }
    );
  };

  const emitNestGeometry = (
    p1: string,
    p2: string,
    p3: string,
    d13: "in" | "out",
    d23: "in" | "out",
    nestUserScriptedMeta:
      | { d13: "in" | "out"; d23: "in" | "out"; swapped: boolean }
      | undefined,
    nestSwapRule: NestSwapRuleInfo,
    stepNotePrefix: string,
    /** Rim-only on p1–p3 and p2–p3 (no blade/spike/tube tops); “arrow” ending. */
    arrowTerminal = false
  ) => {
    const id = ++shapeCounter;
    const big = constOr("bigBend");
    const hostRef =
      nestAnchorHostBody.get(p1) ?? nestAnchorHostBody.get(p2);
    const bodyName = `_ms${id}_body`;
    const anchorMidName = `_ms${id}_anchorMid`;
    const apexProjName = `_ms${id}_apexProj`;

    const A = fig.pt(p1);
    const B = fig.pt(p2);
    const C = fig.pt(p3);

    const nestSharedBaseOutBend = (f: Figure, refNm: string): number =>
      resolveSignedBend(f.pt(p1), f.pt(p2), f.pt(refNm), "out", big);

    const midPre = {
      x: (A.x + B.x) * 0.5,
      y: (A.y + B.y) * 0.5,
    };
    const footPre = footOnLineThrough(A, B, C);
    const eff13: "in" | "out" = arrowTerminal ? "out" : d13;
    const eff23: "in" | "out" = arrowTerminal ? "out" : d23;
    const terminalNote = arrowTerminal
      ? `\n**Terminal (arrow):** both sides ${p1}–${p3} and ${p2}–${p3} are drawn as **rim-only** (outward arcs toward ${bodyName}) — no blade, spike, or tube tops.\n`
      : "";
    pushStep(
      `${stepNotePrefix}nest (step-through notes): edge modes toward ${p3}${terminalNote}\n${formatNestApexSwapRationale(
        fig.pt(p1),
        fig.pt(p2),
        fig.pt(p3),
        { a: p1, b: p2, apex: p3 },
        { d13, d23 },
        nestUserScriptedMeta,
        nestSwapRule
      )}\n` +
        `Markers: **${anchorMidName}** = midpoint of ${p1}–${p2} (≈ ${midPre.x.toFixed(1)}, ${midPre.y.toFixed(1)}). **${apexProjName}** = projection of ${p3} onto the infinite line ${p1}–${p2} (≈ ${footPre.x.toFixed(1)}, ${footPre.y.toFixed(1)}) — compare to “left/right of midpoint”. ` +
        (arrowTerminal
          ? `Each new side is a single rim arc away from ${bodyName} (no inward blade or tube).`
          : `Later “rim arc … away from ${bodyName}” is the **perimeter bowing away from the new triangle centroid**, not the script token \`out\`/\`in\`; mode **in** adds blade+tube **after** that rim arc.`),
      [
        { from: p1, to: p2 },
        { from: p1, to: p3 },
        { from: p2, to: p3 },
      ],
      (f) => {
        const Pa = f.pt(p1);
        const Pb = f.pt(p2);
        const Pc = f.pt(p3);
        const mid = { x: (Pa.x + Pb.x) * 0.5, y: (Pa.y + Pb.y) * 0.5 };
        const foot = footOnLineThrough(Pa, Pb, Pc);
        f.point(anchorMidName, mid);
        f.point(apexProjName, foot);
        macroVis(f, anchorMidName);
        macroVis(f, apexProjName);
      }
    );

    if (hostRef) {
      pushStep(
        `nest: shared base outward arc ${p1}–${p2} (prepend — signed bigBend from host ${hostRef}; clipped under host tube fill)`,
        [{ from: p1, to: p2 }],
        (f) => {
          const bOut = nestSharedBaseOutBend(f, hostRef);
          f.beginShapeBuffer();
          f.arc(p1, p2, { bend: bOut, style });
          f.commitShapeBufferPrepend();
        }
      );
    }

    pushStep(
      `nest: triangle centroid ${bodyName} for (${p1}, ${p2}, ${p3})`,
      [
        { from: p1, to: p2 },
        { from: p2, to: p3 },
        { from: p3, to: p1 },
      ],
      (f) => {
        f.point(bodyName, {
          x: (A.x + B.x + C.x) / 3,
          y: (A.y + B.y + C.y) / 3,
        });
        macroVis(f, bodyName);
      }
    );

    const dCh = constOr("distance");
    const k = dCh / (1 - 2 * dCh);

    pushStep(
      `nest: apex marker (green dot) at ${p3}`,
      [{ from: p1, to: p3 }],
      (f) => {
        if (showMacroHelperLabels) {
          f.add(new Dot(f.pt(p3), p3, 5, "#16a34a"));
        }
      }
    );

    const edges: Array<[string, string, "in" | "out", string]> = [
      [p1, p3, eff13, "13"],
      [p2, p3, eff23, "23"],
    ];
    for (const [a, b, mode, suf] of edges) {
      emitShapeEdge(id, a, b, mode, suf, bodyName, k);
    }

    if (!hostRef) {
      pushStep(
        `nest: shared base outward arc ${p1}–${p2} (signed bigBend out from ${bodyName}; no host ref)`,
        [{ from: p1, to: p2 }],
        (f) => {
          const bOut = nestSharedBaseOutBend(f, bodyName);
          f.arc(p1, p2, { bend: bOut, style });
        }
      );
    }

    pushStep(
      `nest: shared base inward arc ${p1}–${p2} (opposite signed bend −bOut vs outward; bigBend scale)`,
      [{ from: p1, to: p2 }],
      (f) => {
        const refNm = hostRef ?? bodyName;
        const bOut = nestSharedBaseOutBend(f, refNm);
        f.arc(p1, p2, { bend: -bOut, style });
      }
    );

    const tubeSpec =
      nestAnchorHostTubeReplay.get(p1) ?? nestAnchorHostTubeReplay.get(p2);
    if (tubeSpec) {
      pushStep(
        `nest: repaint host tube — opaque interior then **side+cap arcs on top** (same order as spike/tube so fill does not halve visible stroke width)`,
        [
          { from: tubeSpec.p1, to: tubeSpec.q1 },
          { from: tubeSpec.q1, to: tubeSpec.q2 },
          { from: tubeSpec.q2, to: tubeSpec.p2 },
        ],
        (f) => {
          const refNm = resolveRefOn(f, tubeSpec.refPointName);
          emitTubeRegionOnly(
            f,
            tubeSpec.p1,
            tubeSpec.p2,
            tubeSpec.q1,
            tubeSpec.q2,
            tubeSpec.dir,
            refNm
          );
          emitTubeArcP1Q1(
            f,
            tubeSpec.p1,
            tubeSpec.q1,
            tubeSpec.dir,
            refNm
          );
          emitTubeArcP2Q2(
            f,
            tubeSpec.p2,
            tubeSpec.q2,
            tubeSpec.dir,
            refNm
          );
          emitTubeCapQ1Q2(
            f,
            tubeSpec.q1,
            tubeSpec.q2,
            tubeSpec.dir,
            refNm
          );
        }
      );
    }
  };

  type NestTubeReplayEntry = {
    p1: string;
    p2: string;
    q1: string;
    q2: string;
    dir: "in" | "out";
    refPointName: string;
  };

  type ParseLayoutCheckpoint = {
    fig: FigureLayoutCheckpoint;
    buildStepsLen: number;
    freePointsLen: number;
    implicitLen: number;
    shapeCounterSnap: number;
    nextTriSnap: number;
    nestHost: Map<string, string>;
    nestTube: Map<string, NestTubeReplayEntry>;
    nextWaveLen: number;
  };

  const saveParseCheckpoint = (
    nextWave: { p1: string; p2: string }[]
  ): ParseLayoutCheckpoint => ({
    fig: fig.layoutCheckpoint(),
    buildStepsLen: buildSteps.length,
    freePointsLen: freePoints.length,
    implicitLen: implicitNestApexes.length,
    shapeCounterSnap: shapeCounter,
    nextTriSnap: nextTriCounter,
    nestHost: new Map(nestAnchorHostBody),
    nestTube: new Map(
      Array.from(nestAnchorHostTubeReplay.entries()).map(([k, v]) => [
        k,
        { ...v },
      ])
    ),
    nextWaveLen: nextWave.length,
  });

  const restoreParseCheckpoint = (
    c: ParseLayoutCheckpoint,
    nextWave: { p1: string; p2: string }[]
  ) => {
    fig.restoreLayoutCheckpoint(c.fig);
    buildSteps.length = c.buildStepsLen;
    freePoints.length = c.freePointsLen;
    implicitNestApexes.length = c.implicitLen;
    shapeCounter = c.shapeCounterSnap;
    nextTriCounter = c.nextTriSnap;
    nestAnchorHostBody.clear();
    for (const [k, v] of c.nestHost) nestAnchorHostBody.set(k, v);
    nestAnchorHostTubeReplay.clear();
    for (const [k, v] of c.nestTube) nestAnchorHostTubeReplay.set(k, v);
    nextWave.length = c.nextWaveLen;
  };

  /**
   * Inferred-apex nest retries: if the proposed apex is inside an already-filled
   * region (tube/spike interior), restore and re-pick. On exhaustion, skip this branch.
   */
  const runNestWithApexLayoutRetries = (opts: {
    p1: string;
    p2: string;
    p3: string;
    nextWave: { p1: string; p2: string }[] | null;
    placeApexSilent: (tryIdx: number) => void;
    implicitPush?: (d13: "in" | "out", d23: "in" | "out") => void;
    nestUserScriptedMeta:
      | { d13: "in" | "out"; d23: "in" | "out"; swapped: boolean }
      | undefined;
    /** When set (e.g. eight-token `nest`), rebuild meta after each apex from swap result. */
    nestUserScriptedMetaFn?: (r: {
      swap: boolean;
      swapRule: NestSwapRuleInfo;
    }) => { d13: "in" | "out"; d23: "in" | "out"; swapped: boolean };
    stepNotePrefix: string;
    arrowTerminal: boolean;
    label: string;
    /** When false (e.g. eight-token `nest`), do not register apex in `freePoints`. Default true. */
    trackFreePointApex?: boolean;
  }) => {
    const maxT = stepped ? 1 : nestLayoutMaxAttempts();
    const wave = opts.nextWave ?? [];
    const cp = saveParseCheckpoint(wave);
    const trackFp = opts.trackFreePointApex !== false;
    for (let k = 0; k < maxT; k++) {
      restoreParseCheckpoint(cp, wave);
      opts.placeApexSilent(k);
      const apex = fig.pt(opts.p3);
      if (fig.isPointInsideAnyFilledRegion(apex)) {
        if (k < maxT - 1) {
          infos.push(
            `${opts.label}: RETRY ${k + 2}/${maxT} — apex ${opts.p3} falls inside an existing filled area.`
          );
          continue;
        }
        infos.push(
          `${opts.label}: apex remained inside filled areas after ${maxT} tries — branch skipped.`
        );
        restoreParseCheckpoint(cp, wave);
        return;
      }
      if (trackFp) freePoints.push(opts.p3);
      let d13: "in" | "out" = "out";
      let d23: "in" | "out" = "in";
      const r = resolveNestSideSwap(opts.p1, opts.p2, opts.p3, fig);
      const nestSwapRule = r.swapRule;
      if (r.swap) {
        d13 = "in";
        d23 = "out";
      }
      const meta =
        opts.nestUserScriptedMetaFn?.(r) ?? opts.nestUserScriptedMeta;
      emitNestGeometry(
        opts.p1,
        opts.p2,
        opts.p3,
        d13,
        d23,
        meta,
        nestSwapRule,
        opts.stepNotePrefix,
        opts.arrowTerminal
      );
      infos.push(
        `${opts.label}: apex accepted on attempt ${k + 1}/${maxT}.`
      );
      opts.implicitPush?.(d13, d23);
      return;
    }
    restoreParseCheckpoint(cp, wave);
  };

  for (let i = 0; i < scriptLines.length; i++) {
    const lineNum = i + 1;
    const stripped = scriptLines[i]!.replace(/#.*/, "").trim();
    if (!stripped) continue;

    const tokens = stripped.split(/\s+/);
    const cmd = tokens[0].toLowerCase();

    try {
      scriptLineNum = lineNum;
      switch (cmd) {
        case "const": {
          if (tokens.length !== 3) {
            throw new Error("usage: const NAME VALUE");
          }
          const [, name, valStr] = tokens;
          const v = num(valStr);
          pushStep(`const ${name} = ${v}`, undefined, (_f) => {
            consts.set(name, v);
          });
          break;
        }

        case "point": {
          if (tokens.length !== 4) {
            throw new Error("usage: point NAME X Y");
          }
          const [, name, xStr, yStr] = tokens;
          const px = num(xStr);
          const py = num(yStr);
          pushStep(
            `point ${name}: set absolute coordinates (${px}, ${py})`,
            undefined,
            (f) => {
              f.point(name, { x: px, y: py });
              if (!stepped) freePoints.push(name);
            }
          );
          break;
        }

        case "lerp": {
          if (tokens.length !== 5) {
            throw new Error("usage: lerp NAME FROM TO T");
          }
          const [, name, from, to, tStr] = tokens;
          const t = num(tStr);
          pushStep(
            `lerp ${name}: on straight chord ${from}→${to} at parameter t = ${t} (same as distance along chord)`,
            [{ from, to }],
            (f) => {
              f.lerpPoint(name, from, to, t);
            }
          );
          break;
        }

        case "arc": {
          // Two forms:
          //   arc FROM TO BEND
          //   arc FROM TO in|out REF BEND
          if (tokens.length === 4) {
            const [, from, to, bendStr] = tokens;
            const b = num(bendStr);
            pushStep(
              `arc ${from}→${to}: signed bend = ${b} (no ref)`,
              [{ from, to }],
              (f) => {
                f.arc(from, to, { bend: b, style });
              }
            );
          } else if (tokens.length === 6) {
            const [, from, to, dirRaw, refTok, bendStr] = tokens;
            const dir = parseDir(dirRaw);
            const b = num(bendStr);
            pushStep(
              `arc ${from}→${to}: bend ${b}, dir=${dir}, ref token ${refTok} (resolved when this step runs)`,
              [{ from, to }],
              (f) => {
                f.arc(from, to, {
                  bend: b,
                  dir,
                  ref: resolveRefOn(f, refTok),
                  style,
                });
              }
            );
          } else {
            throw new Error(
              "usage: arc FROM TO BEND  |  arc FROM TO in|out REF BEND"
            );
          }
          break;
        }

        case "spike": {
          // spike P1 P2 Q1 Q2 in|out REF
          //   Q1, Q2 are computed automatically (perpendicular to the chord,
          //   random lengths in the tubeAverageHeight ± tubeAverageSpan% band,
          //   or [tubeHeightLow, tubeHeightHigh] if both legacy consts are set;
          //   stable across edits because seeded by "q1|q2").
          if (tokens.length !== 7) {
            throw new Error("usage: spike P1 P2 Q1 Q2 in|out REF");
          }
          const [, p1, p2, q1, q2, dirRaw, refTok] = tokens;
          emitSpike(p1, p2, q1, q2, parseDir(dirRaw), refTok);
          break;
        }

        case "tube": {
          // tube P1 P2 Q1 Q2 in|out REF
          if (tokens.length !== 7) {
            throw new Error("usage: tube P1 P2 Q1 Q2 in|out REF");
          }
          const [, p1, p2, q1, q2, dirRaw, refTok] = tokens;
          const dirT = parseDir(dirRaw);
          pushStep(
            `tube: opaque interior (${p1}→${q1}→${q2}→${p2}), ref ${refTok}, ${dirT}`,
            [
              { from: p1, to: q1 },
              { from: q1, to: q2 },
              { from: q2, to: p2 },
            ],
            (f) => {
              emitTubeRegionOnly(
                f,
                p1,
                p2,
                q1,
                q2,
                dirT,
                resolveRefOn(f, refTok)
              );
            }
          );
          pushStep(
            `tube: side arc ${p1}→${q1} (${dirT})`,
            [{ from: p1, to: q1 }],
            (f) => {
              emitTubeArcP1Q1(f, p1, q1, dirT, resolveRefOn(f, refTok));
            }
          );
          pushStep(
            `tube: side arc ${p2}→${q2} (${dirT})`,
            [{ from: p2, to: q2 }],
            (f) => {
              emitTubeArcP2Q2(f, p2, q2, dirT, resolveRefOn(f, refTok));
            }
          );
          pushStep(
            `tube: cap arc ${q1}→${q2} (smallBend, ${dirT})`,
            [{ from: q1, to: q2 }],
            (f) => {
              emitTubeCapQ1Q2(f, q1, q2, dirT, resolveRefOn(f, refTok));
            }
          );
          break;
        }

        case "blade": {
          // blade FROM TO IN1 IN2 in|out REF
          if (tokens.length !== 7) {
            throw new Error(
              "usage: blade FROM TO INNER1 INNER2 in|out REF"
            );
          }
          const [, from, to, in1, in2, dirRaw, refTok] = tokens;
          const dirB = parseDir(dirRaw);
          emitBlade(from, to, in1, in2, dirB, refTok);
          break;
        }

        case "myshape": {
          // myShape P1 P2 P3 d12 d13 d23
          //   For each edge in the order (P1-P2), (P1-P3), (P2-P3):
          //     dij = "out" -> one plain outward arc <a>-<b>.
          //     dij = "in"  -> outward arc <a>-<b>
          //                  + blade <a> <b> Fij Gij in  <body>
          //                  + spike Fij Gij Xij Yij out <body>
          //   The spike's opaque region is drawn last on the edge, so it
          //   correctly clips the outward arc where the two overlap.
          //   <body> is a synthetic point at the centroid of P1,P2,P3.
          //   Fij/Gij/Xij/Yij are auto-named so calls don't collide.
          if (tokens.length !== 7) {
            throw new Error(
              "usage: myShape P1 P2 P3 in|out in|out in|out"
            );
          }
          const [, p1, p2, p3, d12Raw, d13Raw, d23Raw] = tokens;
          const id = ++shapeCounter;

          // Centroid body point. Compute it directly so this works even when
          // P1/P2/P3 have multi-character names (the implicit `ABC` body-ref
          // trick relies on single-letter names).
          const A = fig.pt(p1);
          const B = fig.pt(p2);
          const C = fig.pt(p3);
          const bodyName = `_ms${id}_body`;
          pushStep(
            `myShape: body centroid ${bodyName} = average of ${p1}, ${p2}, ${p3}`,
            [
              { from: p1, to: p2 },
              { from: p2, to: p3 },
              { from: p3, to: p1 },
            ],
            (f) => {
              f.point(bodyName, {
                x: (A.x + B.x + C.x) / 3,
                y: (A.y + B.y + C.y) / 3,
              });
              macroVis(f, bodyName);
            }
          );

          const dCh = constOr("distance");
          const k = dCh / (1 - 2 * dCh);

          const edges: Array<[string, string, "in" | "out", string]> = [
            [p1, p2, parseDir(d12Raw), "12"],
            [p1, p3, parseDir(d13Raw), "13"],
            [p2, p3, parseDir(d23Raw), "23"],
          ];
          for (const [a, b, mode, suf] of edges) {
            emitShapeEdge(id, a, b, mode, suf, bodyName, k);
          }

          const passMax = nestContinuationMax();
          if (passMax > 0) {
            let wave = pendingInAnchors.splice(0, pendingInAnchors.length);
            for (let pass = 0; pass < passMax && wave.length > 0; pass++) {
              const nextWave: { p1: string; p2: string }[] = [];
              continuationAnchorSink = (pair) => {
                nextWave.push(pair);
              };
              try {
                for (let wi = 0; wi < wave.length; wi++) {
                  const { p1: na, p2: nb } = wave[wi]!;
                  const inferredA = inferNestApexFromAnchors(na, nb);
                  if (!inferredA) continue;
                  const p3a = inferredA;
                  const hostBody =
                    nestAnchorHostBody.get(na) ?? nestAnchorHostBody.get(nb);
                  const arrowTerminal =
                    continuationEndArrow() &&
                    passMax > 1 &&
                    pass === passMax - 1;
                  const stepPf = `[auto nest pass ${pass + 1}/${passMax}, pair ${wi + 1}/${wave.length}] `;
                  if (!stepped) {
                    runNestWithApexLayoutRetries({
                      p1: na,
                      p2: nb,
                      p3: p3a,
                      nextWave,
                      placeApexSilent: (tryIdx) => {
                        if (hostBody) {
                          computeNestPerpAwayFromOnFigure(
                            fig,
                            p3a,
                            na,
                            nb,
                            hostBody,
                            tryIdx
                          );
                        } else {
                          computeNestApexRandomLrOnFigure(
                            fig,
                            p3a,
                            na,
                            nb,
                            tryIdx
                          );
                        }
                      },
                      nestUserScriptedMeta: undefined,
                      stepNotePrefix: stepPf,
                      arrowTerminal,
                      label: `Auto nest ${na}–${nb}`,
                    });
                  } else {
                    if (hostBody) {
                      placePerpAwayFrom(p3a, na, nb, hostBody, "nest");
                    } else {
                      placeNestApexRandomLr(p3a, na, nb);
                    }
                    freePoints.push(p3a);
                    let da13: "in" | "out" = "out";
                    let da23: "in" | "out" = "in";
                    const rAuto = resolveNestSideSwap(na, nb, p3a, fig);
                    const swapRuleAuto = rAuto.swapRule;
                    if (rAuto.swap) {
                      da13 = "in";
                      da23 = "out";
                    }
                    emitNestGeometry(
                      na,
                      nb,
                      p3a,
                      da13,
                      da23,
                      undefined,
                      swapRuleAuto,
                      stepPf,
                      arrowTerminal
                    );
                  }
                }
              } finally {
                continuationAnchorSink = null;
              }
              wave = nextWave;
            }
          } else {
            pendingInAnchors.length = 0;
          }
          break;
        }

        case "perp": {
          // perp NAME P1 P2 awayFrom REF
          //   Place NAME using averageSize ± averageSpan% along the perpendicular
          //   from the chord midpoint (away from REF), plus a random parallel
          //   shift along the chord (see topDisplacement). Registered as a free point.
          if (
            tokens.length !== 6 ||
            tokens[4].toLowerCase() !== "awayfrom"
          ) {
            throw new Error("usage: perp NAME P1 P2 awayFrom REF");
          }
          const [, name, p1, p2, , refTok] = tokens;
          placePerpAwayFrom(name, p1, p2, refTok);
          freePoints.push(name);
          break;
        }

        case "nest": {
          let p1: string;
          let p2: string;
          let p3: string;
          let d13: "in" | "out" = "out";
          let d23: "in" | "out" = "out";
          let nestUserScriptedMeta:
            | { d13: "in" | "out"; d23: "in" | "out"; swapped: boolean }
            | undefined;
          let nestSwapRule: NestSwapRuleInfo = {
            kind: "dotFallback",
            dotFallback: 0,
          };
          let nestEmitDone = false;

          if (tokens.length === 3) {
            [, p1, p2] = tokens;
            const inferred = inferNestApexFromAnchors(p1, p2);
            if (!inferred) {
              throw new Error(
                "usage: nest P1 P2  — P1 and P2 must match …a / …b (e.g. T1a T1b → T1c). " +
                  "Apex offset uses the host triangle body when anchors were minted here; " +
                  "use nest P1 P2 REF to force awayFrom. Or: nest P1 P2 P3 …"
              );
            }
            p3 = inferred;
            const hostBody =
              nestAnchorHostBody.get(p1) ?? nestAnchorHostBody.get(p2);
            if (!stepped) {
              runNestWithApexLayoutRetries({
                p1,
                p2,
                p3,
                nextWave: null,
                placeApexSilent: (tryIdx) => {
                  if (hostBody) {
                    computeNestPerpAwayFromOnFigure(
                      fig,
                      p3,
                      p1,
                      p2,
                      hostBody,
                      tryIdx
                    );
                  } else {
                    computeNestApexRandomLrOnFigure(fig, p3, p1, p2, tryIdx);
                  }
                },
                implicitPush: (d13r, d23r) => {
                  implicitNestApexes.push({
                    apex: p3,
                    p1,
                    p2,
                    d13: d13r,
                    d23: d23r,
                    lineNum: scriptLineNum,
                  });
                },
                nestUserScriptedMeta: undefined,
                stepNotePrefix: "",
                arrowTerminal: false,
                label: `nest ${p1} ${p2}→${p3}`,
              });
              nestEmitDone = true;
            } else {
              if (hostBody) {
                placePerpAwayFrom(p3, p1, p2, hostBody, "nest");
              } else {
                placeNestApexRandomLr(p3, p1, p2);
              }
              freePoints.push(p3);
              d13 = "out";
              d23 = "in";
              const r3 = resolveNestSideSwap(p1, p2, p3, fig);
              nestSwapRule = r3.swapRule;
              if (r3.swap) {
                d13 = "in";
                d23 = "out";
              }
              implicitNestApexes.push({
                apex: p3,
                p1,
                p2,
                d13,
                d23,
                lineNum: scriptLineNum,
              });
            }
          } else if (tokens.length === 4) {
            let refTok: string;
            [, p1, p2, refTok] = tokens;
            const inferred = inferNestApexFromAnchors(p1, p2);
            if (!inferred) {
              throw new Error(
                "usage: nest P1 P2 REF  — P1 and P2 must match …a / …b (e.g. T2a T2b); " +
                  "REF is the awayFrom body (e.g. ABC). Or: nest P1 P2  |  nest P1 P2 P3 …"
              );
            }
            p3 = inferred;
            if (!stepped) {
              runNestWithApexLayoutRetries({
                p1,
                p2,
                p3,
                nextWave: null,
                placeApexSilent: (tryIdx) => {
                  computeNestPerpAwayFromOnFigure(
                    fig,
                    p3,
                    p1,
                    p2,
                    refTok,
                    tryIdx
                  );
                },
                implicitPush: (d13r, d23r) => {
                  implicitNestApexes.push({
                    apex: p3,
                    p1,
                    p2,
                    awayRef: refTok,
                    d13: d13r,
                    d23: d23r,
                    lineNum: scriptLineNum,
                  });
                },
                nestUserScriptedMeta: undefined,
                stepNotePrefix: "",
                arrowTerminal: false,
                label: `nest ${p1} ${p2} ${refTok}→${p3}`,
              });
              nestEmitDone = true;
            } else {
              placePerpAwayFrom(p3, p1, p2, refTok, "nest");
              freePoints.push(p3);
              d13 = "out";
              d23 = "in";
              const r4 = resolveNestSideSwap(p1, p2, p3, fig);
              nestSwapRule = r4.swapRule;
              if (r4.swap) {
                d13 = "in";
                d23 = "out";
              }
              implicitNestApexes.push({
                apex: p3,
                p1,
                p2,
                awayRef: refTok,
                d13,
                d23,
                lineNum: scriptLineNum,
              });
            }
          } else if (tokens.length === 6) {
            let d13Raw: string;
            let d23Raw: string;
            [, p1, p2, p3, d13Raw, d23Raw] = tokens;
            if (!fig.has(p3)) {
              throw new Error(
                `nest: P3 "${p3}" is not defined; either define it with ` +
                  `\`point\` / \`perp\` first, or use the ` +
                  `\`nest P1 P2 P3 awayFrom REF d13 d23\` form`
              );
            }
            const u13 = parseDir(d13Raw);
            const u23 = parseDir(d23Raw);
            d13 = u13;
            d23 = u23;
            const r6 = resolveNestSideSwap(p1, p2, p3, fig);
            nestSwapRule = r6.swapRule;
            if (r6.swap) {
              const t = d13;
              d13 = d23;
              d23 = t;
            }
            nestUserScriptedMeta = {
              d13: u13,
              d23: u23,
              swapped: r6.swap,
            };
          } else if (
            tokens.length === 8 &&
            tokens[4].toLowerCase() === "awayfrom"
          ) {
            let d13Raw: string;
            let d23Raw: string;
            let refTok: string;
            [, p1, p2, p3, , refTok, d13Raw, d23Raw] = tokens;
            const u13b = parseDir(d13Raw);
            const u23b = parseDir(d23Raw);
            if (!stepped) {
              runNestWithApexLayoutRetries({
                p1,
                p2,
                p3,
                nextWave: null,
                placeApexSilent: (tryIdx) => {
                  computeNestPerpAwayFromOnFigure(
                    fig,
                    p3,
                    p1,
                    p2,
                    refTok,
                    tryIdx
                  );
                },
                nestUserScriptedMetaFn: (r) => ({
                  d13: u13b,
                  d23: u23b,
                  swapped: r.swap,
                }),
                nestUserScriptedMeta: undefined,
                stepNotePrefix: "",
                arrowTerminal: false,
                label: `nest ${p1} ${p2} ${p3} awayFrom ${refTok}`,
                trackFreePointApex: false,
              });
              nestEmitDone = true;
            } else {
              placePerpAwayFrom(p3, p1, p2, refTok, "nest");
              d13 = u13b;
              d23 = u23b;
              const r8 = resolveNestSideSwap(p1, p2, p3, fig);
              nestSwapRule = r8.swapRule;
              if (r8.swap) {
                const t = d13;
                d13 = d23;
                d23 = t;
              }
              nestUserScriptedMeta = {
                d13: u13b,
                d23: u23b,
                swapped: r8.swap,
              };
            }
          } else {
            throw new Error(
              "usage: nest P1 P2  |  nest P1 P2 REF  |  nest P1 P2 P3 in|out in|out  |  " +
                "nest P1 P2 P3 awayFrom REF in|out in|out"
            );
          }

          if (!nestEmitDone) {
            emitNestGeometry(
              p1,
              p2,
              p3,
              d13,
              d23,
              nestUserScriptedMeta,
              nestSwapRule,
              "",
              false
            );
          }
          break;
        }

        case "line": {
          if (tokens.length !== 3) {
            throw new Error("usage: line FROM TO");
          }
          const fromL = tokens[1];
          const toL = tokens[2];
          pushStep(
            `line ${fromL}→${toL}: straight segment`,
            [{ from: fromL, to: toL }],
            (f) => {
              f.line(fromL, toL, style);
            }
          );
          break;
        }

        case "dot": {
          if (tokens.length < 2) {
            throw new Error("usage: dot NAME [NAME ...]");
          }
          for (let j = 1; j < tokens.length; j++) {
            const nm = tokens[j];
            pushStep(
              showScriptDots
                ? `dot ${nm}: label marker`
                : `dot ${nm}: skipped (UI: script dots hidden)`,
              undefined,
              (f) => {
                if (showScriptDots) f.dot(nm);
              }
            );
          }
          break;
        }

        case "markers": {
          if (tokens.length < 2) {
            throw new Error("usage: markers NAME [NAME ...]");
          }
          for (let j = 1; j < tokens.length; j++) {
            const nm = tokens[j];
            pushStep(
              showScriptDots
                ? `markers ${nm}: dot without text`
                : `markers ${nm}: skipped (UI: script dots hidden)`,
              undefined,
              (f) => {
                if (showScriptDots) f.marker(nm);
              }
            );
          }
          break;
        }

        default:
          throw new Error(`unknown command "${cmd}"`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`line ${lineNum}: ${msg}`);
    }
  }

  return {
    figure: fig,
    errors,
    infos: infos.length > 0 ? infos : undefined,
    freePoints: stepped ? scanFreePointNamesFromScript(script) : freePoints,
    implicitNestApexes,
    buildSteps: stepped ? buildSteps : undefined,
  };
}

/**
 * Sync the script with a free-point drag.
 *
 *   - If `name` is already defined by an explicit `point NAME X Y` line, the
 *     X and Y on that line are updated in place (preserving spacing and any
 *     trailing comment).
 *   - If `name` was defined by a `perp NAME P1 P2 awayFrom REF` line, that
 *     line is rewritten to a literal `point NAME X Y` line. The first drag
 *     thus "freezes" the auto-computed position; subsequent drags fall into
 *     the case above.
 *   - If `name` is the inferred apex of a `nest P1 P2` or `nest P1 P2 REF` line,
 *     that line is replaced by `point NAME X Y` plus a six- or eight-token `nest`
 *     that keeps the same auto `d13`/`d23` (see {@link ParseResult.implicitNestApexes}).
 *   - Otherwise the script is returned unchanged.
 */
export function updatePointInScript(
  script: string,
  name: string,
  x: number,
  y: number
): string {
  const escName = escapeRegex(name);

  const ptRe = new RegExp(
    `^(\\s*point\\s+${escName}\\s+)\\S+(\\s+)\\S+([^\\n]*)$`,
    "m"
  );
  if (ptRe.test(script)) {
    return script.replace(ptRe, `$1${Math.round(x)}$2${Math.round(y)}$3`);
  }

  // `perp NAME P1 P2 awayFrom REF` -> `point NAME X Y` (preserve indent and
  // any trailing comment).
  const perpRe = new RegExp(
    `^(\\s*)perp\\s+${escName}\\b[^\\n#]*(#[^\\n]*)?$`,
    "mi"
  );
  if (perpRe.test(script)) {
    return script.replace(perpRe, (_match, indent: string, comment?: string) => {
      const trail = comment ? ` ${comment}` : "";
      return `${indent}point ${name} ${Math.round(x)} ${Math.round(y)}${trail}`;
    });
  }

  const { implicitNestApexes } = parse(script);
  const nestHit = implicitNestApexes.find((e) => e.apex === name);
  if (nestHit) {
    const lines = script.split("\n");
    const idx = findImplicitNestLineIndex(lines, nestHit);
    if (idx !== null) {
      const old = lines[idx]!;
      const indent = old.match(/^\s*/)?.[0] ?? "";
      const rx = Math.round(x);
      const ry = Math.round(y);
      const ptLine = `${indent}point ${name} ${rx} ${ry}`;
      const nestLine =
        nestHit.awayRef !== undefined
          ? `${indent}nest ${nestHit.p1} ${nestHit.p2} ${name} awayFrom ${nestHit.awayRef} ${nestHit.d13} ${nestHit.d23}`
          : `${indent}nest ${nestHit.p1} ${nestHit.p2} ${name} ${nestHit.d13} ${nestHit.d23}`;
      const hashIdx = old.indexOf("#");
      const trailComment = hashIdx >= 0 ? old.slice(hashIdx).trimEnd() : "";
      const nestWithComment = trailComment
        ? `${nestLine}  ${trailComment}`
        : nestLine;
      lines.splice(idx, 1, ptLine, nestWithComment);
      return lines.join("\n");
    }
  }

  return script;
}

function findImplicitNestLineIndex(
  lines: string[],
  e: ImplicitNestApexInfo
): number | null {
  for (let i = 0; i < lines.length; i++) {
    const stripped = lines[i]!.replace(/#.*/, "").trim();
    if (!stripped) continue;
    const toks = stripped.split(/\s+/);
    if (toks[0]?.toLowerCase() !== "nest") continue;
    if (toks[1] !== e.p1 || toks[2] !== e.p2) continue;
    const inf = inferNestApexFromAnchors(toks[1]!, toks[2]!);
    if (inf !== e.apex) continue;
    if (toks.length === 3 && e.awayRef === undefined) return i;
    if (
      toks.length === 4 &&
      e.awayRef !== undefined &&
      toks[3] === e.awayRef
    ) {
      return i;
    }
  }
  return null;
}

/**
 * Rewrites each script line that starts with `dot` to use `markers` instead, so
 * the figure keeps dots but drops text labels (same positions, no names).
 */
export function scriptDotsToMarkers(script: string): string {
  return script
    .split("\n")
    .map((line) => {
      const trimmed = line.replace(/#.*/, "").trim();
      if (!/^dot(\s|$)/i.test(trimmed)) return line;
      return line.replace(/^(\s*)dot(\s+)/i, (_m, indent: string, sp: string) => {
        return `${indent}markers${sp}`;
      });
    })
    .join("\n");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

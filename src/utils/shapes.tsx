import type { ReactNode } from "react";
import {
  lerp,
  perpControl,
  quadAt,
  quadPath,
  quadSubSegment,
  signTowards,
  type Point,
} from "./geometry";

/**
 * Object model for the figure.
 *
 * Every drawable thing implements `Shape`. Shapes can be composed inside a
 * `Group` (which can also apply an SVG transform), so the same building
 * blocks can be reused at any level of nesting.
 *
 *   const fig = new ArrowFigure(A, B, C);
 *   <svg>{ fig.render() }</svg>
 *
 *   const nested = new Group([
 *     fig,
 *     new Group([new ArrowFigure(...)], "translate(400 0) scale(0.4)"),
 *   ]);
 */

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

export interface Style {
  stroke?: string;
  strokeWidth?: number;
  fill?: string;
  linecap?: "butt" | "round" | "square";
}

const defaultStyle: Required<Style> = {
  stroke: "#000000",
  strokeWidth: 2,
  fill: "none",
  linecap: "round",
};

const merged = (s?: Style): Required<Style> => ({ ...defaultStyle, ...s });

// ---------------------------------------------------------------------------
// Base interface
// ---------------------------------------------------------------------------

let _autoKey = 0;
const nextKey = () => `s${_autoKey++}`;

export interface Shape {
  /** Render the shape as an SVG fragment. `key` is supplied by the parent. */
  render(key?: string): ReactNode;
}

// ---------------------------------------------------------------------------
// Primitive: a quadratic Bezier given by its three explicit control points.
// (Use this when you already have the control point, e.g. from a sub-segment.)
// ---------------------------------------------------------------------------

export class QuadBezier implements Shape {
  p0: Point;
  p1: Point;
  p2: Point;
  style: Style;

  constructor(p0: Point, p1: Point, p2: Point, style: Style = {}) {
    this.p0 = p0;
    this.p1 = p1;
    this.p2 = p2;
    this.style = style;
  }

  render(key: string = nextKey()): ReactNode {
    const s = merged(this.style);
    return (
      <path
        key={key}
        d={quadPath(this.p0, this.p1, this.p2)}
        fill={s.fill}
        stroke={s.stroke}
        strokeWidth={s.strokeWidth}
        strokeLinecap={s.linecap}
      />
    );
  }
}

// ---------------------------------------------------------------------------
// Convenience: an arc from p1 to p2 with a signed perpendicular bend.
// Internally just a QuadBezier whose middle control is perpControl(...).
// ---------------------------------------------------------------------------

export class ArcSeg implements Shape {
  p1: Point;
  p2: Point;
  bend: number;
  style: Style;

  constructor(p1: Point, p2: Point, bend: number, style: Style = {}) {
    this.p1 = p1;
    this.p2 = p2;
    this.bend = bend;
    this.style = style;
  }

  render(key: string = nextKey()): ReactNode {
    return new QuadBezier(
      this.p1,
      perpControl(this.p1, this.p2, this.bend),
      this.p2,
      this.style
    ).render(key);
  }
}

// ---------------------------------------------------------------------------
// Primitive: a straight line segment.
// ---------------------------------------------------------------------------

export class LineSeg implements Shape {
  p1: Point;
  p2: Point;
  style: Style;

  constructor(p1: Point, p2: Point, style: Style = {}) {
    this.p1 = p1;
    this.p2 = p2;
    this.style = style;
  }

  render(key: string = nextKey()): ReactNode {
    const s = merged(this.style);
    return (
      <line
        key={key}
        x1={this.p1.x}
        y1={this.p1.y}
        x2={this.p2.x}
        y2={this.p2.y}
        stroke={s.stroke}
        strokeWidth={s.strokeWidth}
        strokeLinecap={s.linecap}
      />
    );
  }
}

// ---------------------------------------------------------------------------
// Primitive: a labelled dot.
// ---------------------------------------------------------------------------

export class Dot implements Shape {
  p: Point;
  label: string | undefined;
  r: number;
  color: string;

  constructor(p: Point, label?: string, r: number = 3, color: string = "#0f172a") {
    this.p = p;
    this.label = label;
    this.r = r;
    this.color = color;
  }

  render(key: string = nextKey()): ReactNode {
    return (
      <g key={key}>
        <circle cx={this.p.x} cy={this.p.y} r={this.r} fill={this.color} />
        {this.label !== undefined && (
          <text
            x={this.p.x + 6}
            y={this.p.y - 6}
            fontSize={13}
            fontWeight={600}
            fill="#334155"
          >
            {this.label}
          </text>
        )}
      </g>
    );
  }
}

// ---------------------------------------------------------------------------
// Primitive: a closed filled region built from straight + quadratic-Bezier
// segments. The boundary is traversed in the order given (starting at
// `start`); the region is auto-closed back to `start` with `Z`. Used by
// the `tube` macro to paint an opaque fill that hides everything drawn
// earlier inside the tube outline.
// ---------------------------------------------------------------------------

export type RegionSeg =
  | { kind: "line"; to: Point }
  | { kind: "quad"; ctrl: Point; to: Point };

export class Region implements Shape {
  start: Point;
  segments: RegionSeg[];
  fill: string;

  constructor(start: Point, segments: RegionSeg[], fill: string = "white") {
    this.start = start;
    this.segments = segments;
    this.fill = fill;
  }

  render(key: string = nextKey()): ReactNode {
    const parts: string[] = [`M ${this.start.x} ${this.start.y}`];
    for (const s of this.segments) {
      if (s.kind === "line") {
        parts.push(`L ${s.to.x} ${s.to.y}`);
      } else {
        parts.push(`Q ${s.ctrl.x} ${s.ctrl.y} ${s.to.x} ${s.to.y}`);
      }
    }
    parts.push("Z");
    return (
      <path key={key} d={parts.join(" ")} fill={this.fill} stroke="none" />
    );
  }
}

// ---------------------------------------------------------------------------
// Composite: a "blade" between p1 and p2.
//
//                      ___________________
//             X /     /                   \      \ Y
//              |     /  (clipped middle    \     |
//              |    / of the outwards arc - \    |
//              |   /  not drawn)             \   |
//              |  /                           \  |
//      p1 ----F                                 G---- p2     <- straight chord
//              \                                /             (F, G live here)
//               \                              /
//                \____________________________/             <- inwards F-G arc
//
//   Visible pieces (drawn):
//     * outer arc sub-segment p1 -> X            (left part of outwards arc)
//     * outer arc sub-segment Y -> p2            (right part of outwards arc)
//     * line F -> X                              (left "extruding" line)
//     * line G -> Y                              (right "extruding" line)
//     * inwards arc F -> G                       (the small inner curve)
//
//   Hidden:
//     * outer arc sub-segment X -> Y             (clipped by the F/G tube)
//
//   F = lerp(p1, p2, t1), G = lerp(p1, p2, t2) -> on the *straight* chord
//   X = quadAt(p1, Pouter, p2, t1)              -> directly perpendicular
//   Y = quadAt(p1, Pouter, p2, t2)                from F / G to the outer arc
// ---------------------------------------------------------------------------

export interface BladeOptions {
  /**
   * Signed perpendicular bend of the outer (outwards) arc from p1 to p2.
   * Use `signTowards(p1, p2, ref)` * magnitude to bend toward ref, or
   * its negation to bend away.
   */
  outerBend: number;
  /**
   * Signed perpendicular bend of the inner (inwards) arc from F to G.
   * Pass with the *opposite sign* to outerBend for a true "one inwards,
   * one outwards" pair (arcs on opposite sides of the chord).
   */
  innerBend: number;
  /** F position along the straight chord p1->p2 (0..1). */
  t1: number;
  /** G position along the straight chord p1->p2 (0..1, > t1). */
  t2: number;
  /**
   * If set and non-zero, F→X and G→Y are quadratic arcs (bend = fraction of each
   * leg’s chord length), bulging toward the outer arc’s control side — same role as
   * parser `tubeBend` on spike/tube legs. If omitted or 0, those legs stay straight.
   */
  tubeLegBend?: number;
  style?: Style;
  showLabels?: boolean;
  innerLabels?: [string, string]; // labels for F, G (or D, E)
  tipLabels?: [string, string];   // labels for X, Y
}

export class Blade implements Shape {
  p1: Point;
  p2: Point;
  opts: BladeOptions;

  constructor(p1: Point, p2: Point, opts: BladeOptions) {
    this.p1 = p1;
    this.p2 = p2;
    this.opts = opts;
  }

  /**
   * Build a Blade where both arcs bulge AWAY from `ref` ("outwards"),
   * the outer one with magnitude `outerMag` and the inner one with the
   * smaller `innerMag`, so the inner arc sits between the chord and the
   * outer arc on the same side. Pass `innerMag` negative to flip the
   * inner arc to the opposite side of the chord.
   */
  static splitAround(
    p1: Point,
    p2: Point,
    ref: Point,
    outerMag: number,
    innerMag: number,
    rest: Omit<BladeOptions, "outerBend" | "innerBend">
  ): Blade {
    const sgn = signTowards(p1, p2, ref);
    return new Blade(p1, p2, {
      ...rest,
      outerBend: -sgn * Math.abs(outerMag), // away from ref
      innerBend: -sgn * innerMag,           // same side; pass negative innerMag to flip
    });
  }

  /** Geometry used for drawing and for {@link Figure.collectStrokeLayoutSamples} (no label dots). */
  getStrokeSubshapes(): Shape[] {
    const { outerBend, innerBend, t1, t2, style, tubeLegBend } = this.opts;
    const Pouter = perpControl(this.p1, this.p2, outerBend);
    const F = lerp(this.p1, this.p2, t1);
    const G = lerp(this.p1, this.p2, t2);
    const X = quadAt(this.p1, Pouter, this.p2, t1);
    const Y = quadAt(this.p1, Pouter, this.p2, t2);
    const left = quadSubSegment(this.p1, Pouter, this.p2, 0, t1);
    const right = quadSubSegment(this.p1, Pouter, this.p2, t2, 1);
    const Pinner = perpControl(F, G, innerBend);
    const legBendMag =
      tubeLegBend != null && Math.abs(tubeLegBend) > 1e-12
        ? Math.abs(tubeLegBend)
        : 0;
    const parts: Shape[] = [
      new QuadBezier(left[0], left[1], left[2], style),
      new QuadBezier(right[0], right[1], right[2], style),
    ];
    if (legBendMag !== 0) {
      const bFX = signTowards(F, X, Pouter) * legBendMag;
      const bGY = signTowards(G, Y, Pouter) * legBendMag;
      parts.push(new QuadBezier(F, perpControl(F, X, bFX), X, style));
      parts.push(new QuadBezier(G, perpControl(G, Y, bGY), Y, style));
    } else {
      parts.push(new LineSeg(F, X, style));
      parts.push(new LineSeg(G, Y, style));
    }
    parts.push(new QuadBezier(F, Pinner, G, style));
    return parts;
  }

  render(key: string = nextKey()): ReactNode {
    const { outerBend, t1, t2 } = this.opts;
    const Pouter = perpControl(this.p1, this.p2, outerBend);
    const F = lerp(this.p1, this.p2, t1);
    const G = lerp(this.p1, this.p2, t2);
    const X = quadAt(this.p1, Pouter, this.p2, t1);
    const Y = quadAt(this.p1, Pouter, this.p2, t2);

    const parts: Shape[] = [...this.getStrokeSubshapes()];

    if (this.opts.showLabels) {
      const [lF, lG] = this.opts.innerLabels ?? ["F", "G"];
      const [lX, lY] = this.opts.tipLabels ?? ["X", "Y"];
      parts.push(new Dot(F, lF));
      parts.push(new Dot(G, lG));
      parts.push(new Dot(X, lX));
      parts.push(new Dot(Y, lY));
    }

    return <g key={key}>{parts.map((s, i) => s.render(`p${i}`))}</g>;
  }
}

// ---------------------------------------------------------------------------
// Composite: a group of shapes with optional SVG transform.
// ---------------------------------------------------------------------------

export class Group implements Shape {
  children: Shape[];
  transform: string | undefined;

  constructor(children: Shape[], transform?: string) {
    this.children = children;
    this.transform = transform;
  }

  withTransform(transform: string): Group {
    return new Group(this.children, transform);
  }

  render(key: string = nextKey()): ReactNode {
    return (
      <g key={key} transform={this.transform}>
        {this.children.map((c, i) => c.render(`c${i}`))}
      </g>
    );
  }
}

// ---------------------------------------------------------------------------
// Figure: a small declarative builder.
//
// Define named points, draw arcs/lines/dots between them. Each call returns
// `this`, so the figure reads top-to-bottom like a script.
//
//   const fig = new Figure()
//     .point("A", { x: 100, y: 100 })
//     .point("B", { x: 300, y: 100 })
//     .point("C", { x: 200, y: 300 })
//     .lerpPoint("F", "A", "C", 0.2)
//     .arc("A", "B", { bend: 0.30, ref: "C", dir: "out" })
//     .arc("A", "C", { bend: 0.20, ref: "B", dir: "in"  })
//     .dot("A").dot("B").dot("C").dot("F");
//
//   <svg>{ fig.render() }</svg>
//
// Figures themselves are Shapes, so they nest: `outer.add(innerFigure)`,
// or wrap one in a Group with a transform for placement.
// ---------------------------------------------------------------------------

export interface ArcOptions {
  /** Bend magnitude (fraction of chord length). Treated as unsigned when ref+dir are given. */
  bend: number;
  /** Optional reference point (by name); together with `dir` it picks the bend side. */
  ref?: string;
  /** "in" = bulge toward `ref`, "out" = bulge away from `ref`. */
  dir?: "in" | "out";
  style?: Style;
}

/** Snapshot for {@link Figure.restoreLayoutCheckpoint} (parser nest layout retries). */
export type FigureLayoutCheckpoint = {
  points: Map<string, Point>;
  shapeCount: number;
  shapeBuffer: Shape[] | null;
};

export class Figure implements Shape {
  private points = new Map<string, Point>();
  private shapes: Shape[] = [];
  /**
   * When non-null, `enqueueShape` appends here instead of to `shapes`.
   * Used by the parser to capture a batch of primitives and then prepend
   * them in one shot (see `commitShapeBufferPrepend`) so they render under
   * everything drawn earlier in the same parse — e.g. a nested triangle's
   * base edge drawn *under* a parent tube so the parent's opaque fill can
   * clip the child's outward arc.
   */
  private shapeBuffer: Shape[] | null = null;

  /** Define a point at absolute coordinates. */
  point(name: string, p: Point): this {
    this.points.set(name, p);
    return this;
  }

  /** Define a point by linear interpolation along the chord between two existing points. */
  lerpPoint(name: string, from: string, to: string, t: number): this {
    this.points.set(name, lerp(this.pt(from), this.pt(to), t));
    return this;
  }

  /** Look up a point by name. Throws if not defined. */
  pt(name: string): Point {
    const p = this.points.get(name);
    if (!p) throw new Error(`Figure: unknown point "${name}"`);
    return p;
  }

  /** Whether a point with this name has been defined. */
  has(name: string): boolean {
    return this.points.has(name);
  }

  private enqueueShape(shape: Shape): void {
    if (this.shapeBuffer) this.shapeBuffer.push(shape);
    else this.shapes.push(shape);
  }

  /**
   * Subsequent arc/line/dot/add calls are buffered until
   * `commitShapeBufferPrepend` runs; then the buffer is prepended to the
   * main shape list in draw order (so it paints *under* shapes already in
   * the list).
   */
  beginShapeBuffer(): this {
    this.shapeBuffer = [];
    return this;
  }

  commitShapeBufferPrepend(): this {
    if (!this.shapeBuffer || this.shapeBuffer.length === 0) {
      this.shapeBuffer = null;
      return this;
    }
    for (let i = this.shapeBuffer.length - 1; i >= 0; i--) {
      this.shapes.unshift(this.shapeBuffer[i]!);
    }
    this.shapeBuffer = null;
    return this;
  }

  /** Copy point map and truncate drawable lists (used to roll back a failed `nest`). */
  layoutCheckpoint(): FigureLayoutCheckpoint {
    const pts = new Map<string, Point>();
    for (const [k, v] of this.points) {
      pts.set(k, { x: v.x, y: v.y });
    }
    return {
      points: pts,
      shapeCount: this.shapes.length,
      shapeBuffer:
        this.shapeBuffer === null ? null : [...this.shapeBuffer],
    };
  }

  restoreLayoutCheckpoint(c: FigureLayoutCheckpoint): void {
    this.points = new Map();
    for (const [k, v] of c.points) {
      this.points.set(k, { x: v.x, y: v.y });
    }
    this.shapes.length = c.shapeCount;
    if (c.shapeBuffer === null) {
      this.shapeBuffer = null;
    } else {
      this.shapeBuffer = [...c.shapeBuffer];
    }
  }

  /** Draw an arc between two named points. */
  arc(from: string, to: string, opts: ArcOptions): this {
    const p1 = this.pt(from);
    const p2 = this.pt(to);
    let bend = opts.bend;
    if (opts.ref && opts.dir) {
      const sgn = signTowards(p1, p2, this.pt(opts.ref));
      const factor = opts.dir === "in" ? sgn : -sgn;
      bend = factor * Math.abs(opts.bend);
    }
    this.enqueueShape(new ArcSeg(p1, p2, bend, opts.style));
    return this;
  }

  /** Draw a straight line between two named points. */
  line(from: string, to: string, style?: Style): this {
    this.enqueueShape(new LineSeg(this.pt(from), this.pt(to), style));
    return this;
  }

  /** Add a small labelled dot at a named point (label defaults to the name). */
  dot(name: string, label?: string): this {
    this.enqueueShape(new Dot(this.pt(name), label ?? name, 4));
    return this;
  }

  /** Same visual weight as {@link dot} but no text label (see `markers` in the script DSL). */
  marker(name: string): this {
    this.enqueueShape(new Dot(this.pt(name), undefined, 4));
    return this;
  }

  /**
   * Magenta marker + full name for macro-generated helpers (`_ms…`, `__body…`).
   * No-op if the point is not defined (e.g. before that build step runs).
   */
  macroHelperDot(name: string): this {
    if (!this.has(name)) return this;
    this.enqueueShape(new Dot(this.pt(name), name, 4.5, "#a21caf"));
    return this;
  }

  /**
   * Same magenta marker as {@link macroHelperDot} without a text label
   * (for “clean” previews when internal point names would clutter the drawing).
   */
  macroHelperMarker(name: string): this {
    if (!this.has(name)) return this;
    this.enqueueShape(new Dot(this.pt(name), undefined, 4.5, "#a21caf"));
    return this;
  }

  /** Add any other Shape (Blade, Group, another Figure, ...). */
  add(shape: Shape): this {
    this.enqueueShape(shape);
    return this;
  }

  /** Get the underlying group (e.g. to nest under a transform). */
  build(): Group {
    return new Group(this.shapes);
  }

  /**
   * Dense samples along drawable strokes (arcs, lines, region outlines) for
   * approximate geometric checks (e.g. clearance of auto-placed free points).
   */
  collectStrokeLayoutSamples(samplesPerQuad: number = 14): Point[] {
    const out: Point[] = [];
    const n = Math.max(4, Math.floor(samplesPerQuad));
    const sampleQuad = (p0: Point, p1: Point, p2: Point) => {
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        out.push(quadAt(p0, p1, p2, t));
      }
    };
    const walkRegionBoundary = (region: Region) => {
      let cur = region.start;
      out.push(cur);
      for (const seg of region.segments) {
        if (seg.kind === "line") {
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            out.push({
              x: cur.x + (seg.to.x - cur.x) * t,
              y: cur.y + (seg.to.y - cur.y) * t,
            });
          }
          cur = seg.to;
        } else {
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            out.push(quadAt(cur, seg.ctrl, seg.to, t));
          }
          cur = seg.to;
        }
      }
    };
    const walk = (shape: Shape) => {
      if (shape instanceof LineSeg) {
        out.push(shape.p1, shape.p2);
        out.push(lerp(shape.p1, shape.p2, 0.5));
      } else if (shape instanceof ArcSeg) {
        const c = perpControl(shape.p1, shape.p2, shape.bend);
        sampleQuad(shape.p1, c, shape.p2);
      } else if (shape instanceof QuadBezier) {
        sampleQuad(shape.p0, shape.p1, shape.p2);
      } else if (shape instanceof Region) {
        walkRegionBoundary(shape);
      } else if (shape instanceof Group) {
        for (const c of shape.children) walk(c);
      } else if (shape instanceof Blade) {
        for (const c of shape.getStrokeSubshapes()) walk(c);
      }
      // Dot: skip (labels / markers — not stroke clearance targets)
    };
    for (const s of this.shapes) walk(s);
    return out;
  }

  /**
   * Approximate containment check against already painted filled regions
   * (currently `Region`, used by tube/spike interiors).
   */
  isPointInsideAnyFilledRegion(p: Point, quadSamples = 18): boolean {
    const n = Math.max(6, Math.floor(quadSamples));
    const pointInPolygon = (q: Point, poly: Point[]): boolean => {
      if (poly.length < 3) return false;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const a = poly[i]!;
        const b = poly[j]!;
        const intersects =
          a.y > q.y !== b.y > q.y &&
          q.x < ((b.x - a.x) * (q.y - a.y)) / ((b.y - a.y) || 1e-12) + a.x;
        if (intersects) inside = !inside;
      }
      return inside;
    };
    const regionPolygon = (r: Region): Point[] => {
      const out: Point[] = [];
      let cur = r.start;
      out.push(cur);
      for (const seg of r.segments) {
        if (seg.kind === "line") {
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            out.push({
              x: cur.x + (seg.to.x - cur.x) * t,
              y: cur.y + (seg.to.y - cur.y) * t,
            });
          }
          cur = seg.to;
        } else {
          for (let i = 1; i <= n; i++) {
            const t = i / n;
            out.push(quadAt(cur, seg.ctrl, seg.to, t));
          }
          cur = seg.to;
        }
      }
      return out;
    };
    const walk = (shape: Shape): boolean => {
      if (shape instanceof Region) {
        return pointInPolygon(p, regionPolygon(shape));
      }
      if (shape instanceof Group) {
        for (const c of shape.children) {
          if (walk(c)) return true;
        }
      }
      if (shape instanceof Blade) {
        for (const c of shape.getStrokeSubshapes()) {
          if (walk(c)) return true;
        }
      }
      return false;
    };
    for (const s of this.shapes) {
      if (walk(s)) return true;
    }
    return false;
  }

  render(key: string = nextKey()): ReactNode {
    return this.build().render(key);
  }
}

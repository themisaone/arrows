export interface Point {
  x: number;
  y: number;
}

export const lerp = (p1: Point, p2: Point, t: number): Point => ({
  x: p1.x + (p2.x - p1.x) * t,
  y: p1.y + (p2.y - p1.y) * t,
});

export const distance = (p1: Point, p2: Point): number =>
  Math.hypot(p2.x - p1.x, p2.y - p1.y);

/**
 * Quadratic Bezier control point that places the apex at a perpendicular
 * offset from the chord midpoint. The offset is `bend * chord_length`,
 * so curvature is scale-invariant.
 *
 *   bend > 0 -> bulges to the LEFT  of direction p1 -> p2
 *   bend < 0 -> bulges to the RIGHT of direction p1 -> p2
 *
 * Useful property: because the control point sits on the perpendicular
 * bisector, the Bezier parameter t maps exactly to chord position
 * (t=0.5 lies directly above the chord midpoint, t=0.2 directly above
 * lerp(p1, p2, 0.2), etc.). This is what lets us drop a clean
 * perpendicular line from a chord point to the arc.
 */
export const perpControl = (p1: Point, p2: Point, bend: number): Point => {
  const mid: Point = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || bend === 0) return mid;
  return {
    x: mid.x + (-dy / len) * (len * bend),
    y: mid.y + (dx / len) * (len * bend),
  };
};

/**
 * Signed z of (p2−p1)×(p3−p1): which side of the directed line p1→p2 the
 * point p3 lies on. Same handedness as `signTowards(p1,p2,p3)`.
 */
export const crossProdZ = (p1: Point, p2: Point, p3: Point): number =>
  (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);

/**
 * Closest point on the **infinite** line through `p1`–`p2` to `p3`
 * (projection / “drop a perpendicular” foot).
 */
export function footOnLineThrough(p1: Point, p2: Point, p3: Point): Point {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-18) return { x: p1.x, y: p1.y };
  const t = ((p3.x - p1.x) * dx + (p3.y - p1.y) * dy) / len2;
  return { x: p1.x + t * dx, y: p1.y + t * dy };
}

/**
 * Sign (+1 / -1) such that an arc from p1 to p2 with that signed bend
 * value will bulge toward `ref`. Use the negative for "bulge away from".
 */
export const signTowards = (p1: Point, p2: Point, ref: Point): 1 | -1 => {
  const cross = crossProdZ(p1, p2, ref);
  return cross > 0 ? 1 : -1;
};

const NEST_APEX_DOT_EPS = 1e-9;

export type NestApexChordMetrics = {
  degenerate: boolean;
  mx: number;
  my: number;
  /** dot( (p2−p1), viewRight ); viewRight = (forward.y, -forward.x), forward = normalize(p3−M) */
  dotChordVsViewRight: number;
  crossP1P2P3: number;
  /**
   * When true, swap the default nest template (`…a–…c` out, `…b–…c` in) so the
   * blade (`in`) hugs **p1–p3** and the plain arc (`out`) is **p2–p3**.
   *
   * Uses **dot < 0** (not `> 0`): with SVG’s y-down canvas the earlier `> 0`
   * test matched the wrong screen chirality for typical `T*a`/`T*b` nests.
   */
  swap: boolean;
};

export function nestApexChordHandednessMetrics(
  p1: Point,
  p2: Point,
  p3: Point
): NestApexChordMetrics {
  const mx = (p1.x + p2.x) * 0.5;
  const my = (p1.y + p2.y) * 0.5;
  const wx = p3.x - mx;
  const wy = p3.y - my;
  const wlen = Math.hypot(wx, wy);
  const crossP1P2P3 = crossProdZ(p1, p2, p3);
  if (wlen < NEST_APEX_DOT_EPS) {
    return {
      degenerate: true,
      mx,
      my,
      dotChordVsViewRight: 0,
      crossP1P2P3,
      swap: false,
    };
  }
  const fx = wx / wlen;
  const fy = wy / wlen;
  const rx = fy;
  const ry = -fx;
  const ex = p2.x - p1.x;
  const ey = p2.y - p1.y;
  const dotChordVsViewRight = ex * rx + ey * ry;
  const swap = dotChordVsViewRight < -NEST_APEX_DOT_EPS;
  return {
    degenerate: false,
    mx,
    my,
    dotChordVsViewRight,
    crossP1P2P3,
    swap,
  };
}

/** @see nestApexChordHandednessMetrics */
export const nestApexShouldSwapEdgeModes = (
  p1: Point,
  p2: Point,
  p3: Point
): boolean => nestApexChordHandednessMetrics(p1, p2, p3).swap;

export type NestSwapRuleInfo =
  | {
      kind: "footCloser";
      distP1Foot: number;
      distP2Foot: number;
      /** Which anchor the apex projects nearest to on chord p1–p2. */
      closerToFoot: "p1" | "p2";
    }
  | {
      kind: "hostBodyCross";
      hostBody: string;
      crossHost: number;
      crossApex: number;
    }
  | { kind: "dotFallback"; dotFallback: number };

/** Dot((q−M), unit(p2−p1)); positive ⇒ from midpoint M toward p2 along the chord. */
function signedAlongChordFromMid(p1: Point, p2: Point, q: Point): number {
  const mx = (p1.x + p2.x) * 0.5;
  const my = (p1.y + p2.y) * 0.5;
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return (q.x - mx) * ux + (q.y - my) * uy;
}

/**
 * Plain-language bullets: which side of the chord the apex is on, along-chord
 * offset from M, and which anchor side gets the blade (`in`).
 */
function nestApexPlainEnglishBullets(
  p1: Point,
  p2: Point,
  p3: Point,
  names: { a: string; b: string; apex: string },
  finalModes: { d13: "in" | "out"; d23: "in" | "out" },
  crossZ: number,
  swapRule?: NestSwapRuleInfo
): string[] {
  const out: string[] = [];
  const along = signedAlongChordFromMid(p1, p2, p3);
  const chordAlongEps = 1e-3;
  let sideSentence: string;
  if (crossZ > NEST_APEX_DOT_EPS) {
    sideSentence = `${names.apex} lies on your **LEFT** side while walking **${names.a}→${names.b}** (crossZ = ${crossZ.toFixed(2)} > 0). **+** = left of the directed chord in cross-product terms — not necessarily “left on your monitor”.`;
  } else if (crossZ < -NEST_APEX_DOT_EPS) {
    sideSentence = `${names.apex} lies on your **RIGHT** side while walking **${names.a}→${names.b}** (crossZ = ${crossZ.toFixed(2)} < 0).`;
  } else {
    sideSentence = `${names.apex} is **almost on** the infinite line ${names.a}–${names.b} (crossZ ≈ 0).`;
  }

  out.push(
    `* **From M toward ${names.apex}:** I use the chord order **${names.a} → ${names.b}** (same as your script).`
  );
  out.push(`* **Which side of that chord line?** ${sideSentence}`);
  const alongToward =
    along > chordAlongEps
      ? `the projection of ${names.apex} onto the line ${names.a}–${names.b} falls **toward ${names.b}** from M along the chord`
      : along < -chordAlongEps
        ? `that projection falls **toward ${names.a}** from M along the chord`
        : `that projection is **almost straight “above” M** on the chord (tiny along-chord shift)`;
  out.push(
    `* **Along the chord from M:** ${alongToward} (signed along-chord component ≈ ${along.toFixed(2)} px, + toward ${names.b}).`
  );

  if (swapRule?.kind === "footCloser") {
    const closerNm = swapRule.closerToFoot === "p1" ? names.a : names.b;
    const bladeEdge =
      swapRule.closerToFoot === "p1"
        ? `${names.a}–${names.apex}`
        : `${names.b}–${names.apex}`;
    out.push(
      `* **So I put “in” (blade + tube) on ${bladeEdge}** — the projection of ${names.apex} onto ${names.a}–${names.b} lies **closer to ${closerNm}** (dist foot→${names.a} = ${swapRule.distP1Foot.toFixed(2)} px, dist foot→${names.b} = ${swapRule.distP2Foot.toFixed(2)} px). The other new edge is “out” (rim arc only).`
    );
  } else {
    const bladeEdge =
      finalModes.d13 === "in"
        ? `${names.a}–${names.apex}`
        : `${names.b}–${names.apex}`;
    const anchorName = finalModes.d13 === "in" ? names.a : names.b;
    out.push(
      `* **So I put “in” (blade + tube) on ${bladeEdge}** — the inward geometry hugs the **${anchorName}** anchor end (${names.a} vs ${names.b}) per host-cross / dot fallback below. The other new edge is “out” (rim arc only).`
    );
  }
  return out;
}

/**
 * Human-readable “thought” for Step-through build logs when `nest` picks
 * `in`/`out` on the two new sides.
 */
export function formatNestApexSwapRationale(
  p1: Point,
  p2: Point,
  p3: Point,
  names: { a: string; b: string; apex: string },
  finalModes: { d13: "in" | "out"; d23: "in" | "out" },
  userScripted?: { d13: "in" | "out"; d23: "in" | "out"; swapped: boolean },
  swapRule?: NestSwapRuleInfo
): string {
  const m = nestApexChordHandednessMetrics(p1, p2, p3);
  const lines: string[] = [];
  lines.push(
    `Thinking: I stand at M, the midpoint of ${names.a}–${names.b} (≈ (${m.mx.toFixed(1)}, ${m.my.toFixed(1)})), and look toward ${names.apex}.`
  );
  if (m.degenerate) {
    lines.push(
      `${names.apex} is almost on the chord — no chirality swap. Final: ${names.a}–${names.apex}=${finalModes.d13}, ${names.b}–${names.apex}=${finalModes.d23}.`
    );
    return lines.join("\n");
  }
  lines.push(
    ...nestApexPlainEnglishBullets(p1, p2, p3, names, finalModes, m.crossP1P2P3, swapRule)
  );
  lines.push("");
  lines.push("**Technical (rule trace):**");
  if (swapRule?.kind === "footCloser") {
    lines.push(
      `**Primary rule (foot on chord):** distances from the projected foot to ${names.a} / ${names.b} differ enough → put **in** on the **closer** anchor’s new edge (swap iff ${names.a} is closer).`
    );
    lines.push(
      `dist(foot, ${names.a}) = ${swapRule.distP1Foot.toFixed(3)} px, dist(foot, ${names.b}) = ${swapRule.distP2Foot.toFixed(3)} px → closer to **${swapRule.closerToFoot === "p1" ? names.a : names.b}**.`
    );
  } else if (swapRule?.kind === "hostBodyCross") {
    lines.push(
      `**Fallback — host triangle vs new apex** (foot almost equidistant to ${names.a} and ${names.b}): crossZ(${names.a}→${names.b}, centroid ${swapRule.hostBody}) = ${swapRule.crossHost.toFixed(2)}; crossZ(${names.a}→${names.b}, ${names.apex}) = ${swapRule.crossApex.toFixed(2)}.`
    );
    if (swapRule.crossHost * swapRule.crossApex < 0) {
      lines.push(
        `Opposite signs → new apex is on the **opening** side of the anchor chord relative to the host interior → **SWAP** template so the blade (“in”) hugs **${names.a}–${names.apex}**.`
      );
    } else {
      lines.push(
        `Same sign (both on one side of the infinite line) → **NO SWAP** relative to default out/in on the two new sides.`
      );
    }
  } else {
    lines.push(
      `**Fallback — dot heuristic** (foot tie and no usable host-centroid cross):`
    );
    if (m.crossP1P2P3 > NEST_APEX_DOT_EPS) {
      lines.push(
        `crossZ(${names.a}→${names.b}, ${names.apex}) = ${m.crossP1P2P3.toFixed(1)} > 0  →  apex on one side of the directed anchor chord (y-down SVG).`
      );
    } else if (m.crossP1P2P3 < -NEST_APEX_DOT_EPS) {
      lines.push(
        `crossZ = ${m.crossP1P2P3.toFixed(1)} < 0  →  apex on the other side of ${names.a}→${names.b}.`
      );
    } else {
      lines.push(`crossZ ≈ 0 (almost collinear with the anchor chord).`);
    }
    const dotFb =
      swapRule?.kind === "dotFallback" ? swapRule.dotFallback : m.dotChordVsViewRight;
    lines.push(
      `dot = chord·viewRight = ${dotFb.toFixed(3)}. SWAP when dot < 0 (y-down heuristic).`
    );
    if (m.swap) {
      lines.push(
        `→ **SWAP**: put **in** on **${names.a}–${names.apex}**, **out** on **${names.b}–${names.apex}**.`
      );
    } else {
      lines.push(
        `→ **NO SWAP**: **${names.a}–${names.apex}** = out, **${names.b}–${names.apex}** = in.`
      );
    }
  }
  if (userScripted) {
    if (userScripted.swapped) {
      lines.push(
        `You wrote ${names.a}–${names.apex}=${userScripted.d13}, ${names.b}–${names.apex}=${userScripted.d23}; chirality rule **swapped** those → final ${names.a}–${names.apex}=${finalModes.d13}, ${names.b}–${names.apex}=${finalModes.d23}.`
      );
    } else {
      lines.push(
        `You scripted explicit modes; chirality left them unchanged → ${names.a}–${names.apex}=${finalModes.d13}, ${names.b}–${names.apex}=${finalModes.d23}.`
      );
    }
  } else {
    lines.push(
      `Final (auto nest): **${names.a}–${names.apex}** = ${finalModes.d13}, **${names.b}–${names.apex}** = ${finalModes.d23}.`
    );
  }
  return lines.join("\n");
}

/** Quadratic Bezier evaluation at parameter t in [0,1]. */
export const quadAt = (p0: Point, p1: Point, p2: Point, t: number): Point => {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y,
  };
};

/**
 * Control points of the quadratic Bezier sub-segment between parameters
 * `a` and `b` of the original curve (p0, p1, p2). The result is itself a
 * quadratic Bezier and can be drawn directly.
 */
export const quadSubSegment = (
  p0: Point,
  p1: Point,
  p2: Point,
  a: number,
  b: number
): [Point, Point, Point] => {
  const ua = 1 - a;
  const ub = 1 - b;

  const q0: Point = {
    x: ua * ua * p0.x + 2 * a * ua * p1.x + a * a * p2.x,
    y: ua * ua * p0.y + 2 * a * ua * p1.y + a * a * p2.y,
  };
  const q1: Point = {
    x: ua * ub * p0.x + (a * ub + ua * b) * p1.x + a * b * p2.x,
    y: ua * ub * p0.y + (a * ub + ua * b) * p1.y + a * b * p2.y,
  };
  const q2: Point = {
    x: ub * ub * p0.x + 2 * b * ub * p1.x + b * b * p2.x,
    y: ub * ub * p0.y + 2 * b * ub * p1.y + b * b * p2.y,
  };

  return [q0, q1, q2];
};

export const quadPath = (p0: Point, p1: Point, p2: Point): string =>
  `M ${p0.x} ${p0.y} Q ${p1.x} ${p1.y} ${p2.x} ${p2.y}`;

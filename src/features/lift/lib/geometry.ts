import type {
  ArcSegmentSpec,
  CartCard,
  EdgeClearance,
  Pose,
  PoseCheck,
  Vec,
  WallEdge,
} from "./types";

export const EPS = 1e-7;

export function v(x: number, y: number): Vec {
  return { x, y };
}

export function add(a: Vec, b: Vec): Vec {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function sub(a: Vec, b: Vec): Vec {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scale(a: Vec, k: number): Vec {
  return { x: a.x * k, y: a.y * k };
}

export function dot(a: Vec, b: Vec): number {
  return a.x * b.x + a.y * b.y;
}

export function cross(a: Vec, b: Vec): number {
  return a.x * b.y - a.y * b.x;
}

export function norm(a: Vec): number {
  return Math.hypot(a.x, a.y);
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function segmentLength(segment: CartCard["path"][number]): number {
  if (segment.kind === "line") return dist(segment.a, segment.b);
  return segment.radius * Math.abs(segment.deltaAngle);
}

export function pathLength(cart: CartCard): number {
  return cart.path.reduce((sum, segment) => sum + segmentLength(segment), 0);
}

export function pointOnSegmentAtDistance(
  segment: CartCard["path"][number],
  distanceAlong: number,
): Vec {
  const length = segmentLength(segment);
  const q = length <= EPS ? 0 : clamp(distanceAlong / length, 0, 1);
  if (segment.kind === "line") {
    return {
      x: segment.a.x + (segment.b.x - segment.a.x) * q,
      y: segment.a.y + (segment.b.y - segment.a.y) * q,
    };
  }
  const arc = segment as ArcSegmentSpec;
  const angle = arc.startAngle + arc.deltaAngle * q;
  return {
    x: arc.center.x + arc.radius * Math.cos(angle),
    y: arc.center.y + arc.radius * Math.sin(angle),
  };
}

interface Located {
  segment: CartCard["path"][number];
  segmentIndex: number;
  into: number;
  total: number;
}

export function locateDistance(cart: CartCard, distanceAlong: number): Located {
  const total = pathLength(cart);
  let remaining = clamp(distanceAlong, 0, total);
  for (let index = 0; index < cart.path.length; index += 1) {
    const segment = cart.path[index];
    const length = segmentLength(segment);
    if (remaining <= length + EPS || index === cart.path.length - 1) {
      return {
        segment,
        segmentIndex: index,
        into: clamp(remaining, 0, length),
        total,
      };
    }
    remaining -= length;
  }
  const segment = cart.path[cart.path.length - 1];
  return { segment, segmentIndex: cart.path.length - 1, into: segmentLength(segment), total };
}

export function pointAtDistance(cart: CartCard, distanceAlong: number): Vec {
  const located = locateDistance(cart, distanceAlong);
  return pointOnSegmentAtDistance(located.segment, located.into);
}

export function pointAtProgress(cart: CartCard, u: number): Vec {
  const total = pathLength(cart);
  return pointAtDistance(cart, clamp(u, 0, 1) * total);
}

export function progressToDistance(cart: CartCard, u: number): number {
  return clamp(u, 0, 1) * pathLength(cart);
}

/** 受分段速度上限约束的最短走行时间（秒）。 */
export function minimumTravelTime(
  cart: CartCard,
  u0: number,
  u1: number,
): number {
  const total = pathLength(cart);
  const d0 = clamp(u0, 0, 1) * total;
  const d1 = clamp(u1, 0, 1) * total;
  if (d1 <= d0 + EPS) return 0;

  let time = 0;
  let cursor = d0;
  let base = 0;
  for (const segment of cart.path) {
    const length = segmentLength(segment);
    const start = base;
    const end = base + length;
    const takeStart = Math.max(cursor, start);
    const takeEnd = Math.min(d1, end);
    if (takeEnd > takeStart) {
      time += (takeEnd - takeStart) / segment.speed;
      cursor = takeEnd;
    }
    base = end;
    if (cursor >= d1 - EPS) break;
  }
  return time;
}

function orientation(a: Vec, b: Vec, c: Vec): number {
  return cross(sub(b, a), sub(c, a));
}

function onInclusive(a: Vec, b: Vec, p: Vec): boolean {
  return (
    Math.min(a.x, b.x) - EPS <= p.x &&
    p.x <= Math.max(a.x, b.x) + EPS &&
    Math.min(a.y, b.y) - EPS <= p.y &&
    p.y <= Math.max(a.y, b.y) + EPS
  );
}

export function segmentsIntersect(a: Vec, b: Vec, c: Vec, d: Vec): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  if (Math.abs(o1) <= EPS && onInclusive(a, b, c)) return true;
  if (Math.abs(o2) <= EPS && onInclusive(a, b, d)) return true;
  if (Math.abs(o3) <= EPS && onInclusive(c, d, a)) return true;
  if (Math.abs(o4) <= EPS && onInclusive(c, d, b)) return true;

  return (
    (o1 > EPS && o2 < -EPS || o1 < -EPS && o2 > EPS) &&
    (o3 > EPS && o4 < -EPS || o3 < -EPS && o4 > EPS)
  );
}

export function pointSegmentDistance(p: Vec, a: Vec, b: Vec): number {
  const ab = sub(b, a);
  const lengthSquared = dot(ab, ab);
  if (lengthSquared <= EPS) return dist(p, a);
  const q = clamp(dot(sub(p, a), ab) / lengthSquared, 0, 1);
  const projection = add(a, scale(ab, q));
  return dist(p, projection);
}

export function segmentDistance(a: Vec, b: Vec, c: Vec, d: Vec): number {
  if (segmentsIntersect(a, b, c, d)) return 0;
  return Math.min(
    pointSegmentDistance(a, c, d),
    pointSegmentDistance(b, c, d),
    pointSegmentDistance(c, a, b),
    pointSegmentDistance(d, a, b),
  );
}

export function poseAt(
  cartA: CartCard,
  cartB: CartCard,
  uA: number,
  uB: number,
): Pose {
  return { a: pointAtProgress(cartA, uA), b: pointAtProgress(cartB, uB) };
}

export function checkPose(
  pose: Pose,
  beamLength: number,
  beamRadius: number,
  lengthTolerance: number,
  edges: WallEdge[],
): PoseCheck {
  const length = dist(pose.a, pose.b);
  const lengthError = Math.abs(length - beamLength);
  const edgeChecks: EdgeClearance[] = edges.map((edge) => {
    const distance = segmentDistance(pose.a, pose.b, edge.a, edge.b);
    const requiredDistance = beamRadius + edge.halfThickness;
    const clearance = distance - requiredDistance;
    const numericalTouch = Math.abs(clearance) <= 0.012;
    let violated: boolean;
    if (edge.policy === "graze-ok") {
      // 恰好擦边（clearance≈0）允许；只有真正侵入才失败。
      violated = clearance < -1e-6;
    } else {
      // 封条边：数学上的接触即失败；保留极小浮点容差。
      violated = clearance <= 1e-7;
    }
    return {
      edgeId: edge.id,
      name: edge.name,
      policy: edge.policy,
      distance,
      requiredDistance,
      clearance,
      violated,
      contact: numericalTouch || (edge.policy === "sealed" && clearance <= 1e-7),
    };
  });

  const collisions = edgeChecks.filter((e) => e.violated).map((e) => e.edgeId);
  const grazed = edgeChecks
    .filter((e) => e.policy === "graze-ok" && Math.abs(e.clearance) <= 0.012 && !e.violated)
    .map((e) => e.edgeId);
  const sealedTouched = edgeChecks
    .filter((e) => e.policy === "sealed" && e.clearance <= 1e-7 + 0.012)
    .map((e) => e.edgeId);

  return {
    length,
    lengthError,
    lengthOk: lengthError <= lengthTolerance,
    edges: edgeChecks,
    safe: lengthError <= lengthTolerance && collisions.length === 0,
    grazed,
    sealedTouched,
    collisions,
  };
}

export interface SweepResult {
  ok: boolean;
  samples: number;
  worstClearance: number;
  worstEdgeId?: string;
  firstBad?: {
    q: number;
    uA: number;
    uB: number;
    check: PoseCheck;
  };
}

/**
 * 对两端进度区间做密集连续扫掠检查。
 * 进度区间内的所有中间弧长位置都会被单调经过，因此采样覆盖整条扫掠。
 */
export function checkSweep(
  cartA: CartCard,
  cartB: CartCard,
  uA0: number,
  uA1: number,
  uB0: number,
  uB1: number,
  beamLength: number,
  beamRadius: number,
  lengthTolerance: number,
  edges: WallEdge[],
  sampleSpacing = 0.018,
): SweepResult {
  const spanA = Math.abs(progressToDistance(cartA, uA1) - progressToDistance(cartA, uA0));
  const spanB = Math.abs(progressToDistance(cartB, uB1) - progressToDistance(cartB, uB0));
  const span = Math.max(spanA, spanB, beamLength * 0.25);
  const samples = Math.max(10, Math.min(2000, Math.ceil(span / sampleSpacing)));

  let worstClearance = Number.POSITIVE_INFINITY;
  let worstEdgeId: string | undefined;

  for (let k = 0; k <= samples; k += 1) {
    const q = k / samples;
    const uA = uA0 + (uA1 - uA0) * q;
    const uB = uB0 + (uB1 - uB0) * q;
    const pose = poseAt(cartA, cartB, uA, uB);
    const check = checkPose(pose, beamLength, beamRadius, lengthTolerance, edges);
    for (const edge of check.edges) {
      if (edge.clearance < worstClearance) {
        worstClearance = edge.clearance;
        worstEdgeId = edge.edgeId;
      }
    }
    if (!check.safe) {
      return {
        ok: false,
        samples,
        worstClearance,
        worstEdgeId,
        firstBad: { q, uA, uB, check },
      };
    }
  }
  return { ok: true, samples, worstClearance, worstEdgeId };
}

/** 牛顿/最小范数局部精修一个刚性配对，适合把格点吸附到精确配对曲线。 */
export function refineRigidPairNear(
  cartA: CartCard,
  cartB: CartCard,
  beamLength: number,
  uA: number,
  uB: number,
  radius = 0.022,
): { uA: number; uB: number; error: number } | null {
  const originA = uA;
  const originB = uB;
  let x = clamp(uA, 0, 1);
  let y = clamp(uB, 0, 1);
  const h = 1e-6;

  for (let iteration = 0; iteration < 28; iteration += 1) {
    const length = dist(pointAtProgress(cartA, x), pointAtProgress(cartB, y));
    const f = length - beamLength;
    if (Math.abs(f) < 1e-7) return { uA: x, uB: y, error: Math.abs(f) };

    const la = dist(pointAtProgress(cartA, clamp(x + h, 0, 1)), pointAtProgress(cartB, y));
    const lb = dist(pointAtProgress(cartA, x), pointAtProgress(cartB, clamp(y + h, 0, 1)));
    let da = (la - length) / h;
    let db = (lb - length) / h;
    const gradientSquared = da * da + db * db;
    if (gradientSquared < 1e-10) {
      // 在圆弧等距分支上，沿弧方向梯度近似为零；尝试沿另一坐标做有限扫描。
      let best: { x: number; y: number; error: number } | null = null;
      for (let k = -20; k <= 20; k += 1) {
        const yy = clamp(originB + (radius * k) / 20, 0, 1);
        const ll = dist(pointAtProgress(cartA, x), pointAtProgress(cartB, yy));
        const error = Math.abs(ll - beamLength);
        if (!best || error < best.error) best = { x, y: yy, error };
      }
      if (!best || best.error > 0.002) return null;
      y = best.y;
      continue;
    }

    let sx = (-f * da) / gradientSquared;
    let sy = (-f * db) / gradientSquared;
    // 限制单步，避免跨过另一条刚性配对分支。
    const maxStep = radius * 0.35;
    const stepNorm = Math.hypot(sx, sy);
    if (stepNorm > maxStep) {
      sx = (sx / stepNorm) * maxStep;
      sy = (sy / stepNorm) * maxStep;
    }
    const nextX = clamp(x + sx, originA - radius, originA + radius);
    const nextY = clamp(y + sy, originB - radius, originB + radius);
    if (Math.abs(nextX - x) < 1e-10 && Math.abs(nextY - y) < 1e-10) break;
    x = clamp(nextX, 0, 1);
    y = clamp(nextY, 0, 1);
  }

  const error = Math.abs(dist(pointAtProgress(cartA, x), pointAtProgress(cartB, y)) - beamLength);
  return error < 0.002 ? { uA: x, uB: y, error } : null;
}

/** 在当前进度附近做局部连续刚性配对精修。 */
export function refineRigidPair(
  cartA: CartCard,
  cartB: CartCard,
  beamLength: number,
  uA: number,
  uB: number,
  searchRadius = 0.035,
): { uA: number; uB: number; error: number } | null {
  let best: { uA: number; uB: number; error: number } | null = null;
  const steps = 40;
  for (let ia = -steps; ia <= steps; ia += 1) {
    const na = clamp(uA + (ia / steps) * searchRadius, 0, 1);
    // 对每个 A，在 B 的局部窗口扫描距离函数的最近点/零点。
    for (let ib = -steps; ib <= steps; ib += 1) {
      const nb = clamp(uB + (ib / steps) * searchRadius, 0, 1);
      const pose = poseAt(cartA, cartB, na, nb);
      const error = Math.abs(dist(pose.a, pose.b) - beamLength);
      if (!best || error < best.error) best = { uA: na, uB: nb, error };
    }
  }
  if (best && best.error < 0.002) return best;
  return null;
}

import { SCENE } from "./card";
import {
  checkPose,
  checkSweep,
  clamp,
  minimumTravelTime,
  pathLength,
  poseAt,
  refineRigidPairNear,
} from "./geometry";
import type {
  ComboCell,
  EndId,
  Keyframe,
  Plan,
  PoseCheck,
  SceneCard,
} from "./types";

export const MATRIX_N = 61;
const PLAN_N = 241;
const GRID_LENGTH_TOLERANCE = 0.055;

export function buildMatrix(
  scene: SceneCard = SCENE,
  gateId = "gate-1",
  n = MATRIX_N,
): ComboCell[][] {
  const gateEdges = scene.edges.filter((edge) => edge.gateId === gateId);
  const rows: ComboCell[][] = [];
  for (let j = 0; j < n; j += 1) {
    const uB = j / (n - 1);
    const row: ComboCell[] = [];
    for (let i = 0; i < n; i += 1) {
      const uA = i / (n - 1);
      const pose = poseAt(scene.carts.A, scene.carts.B, uA, uB);
      const raw = checkPose(
        pose,
        scene.beamLength,
        scene.beamRadius,
        scene.lengthTolerance,
        scene.edges,
      );
      const refined = refineRigidPairNear(
        scene.carts.A,
        scene.carts.B,
        scene.beamLength,
        uA,
        uB,
        0.85 / (n - 1),
      );
      const repU = refined?.uA ?? uA;
      const repB = refined?.uB ?? uB;
      const rigidBin = Boolean(refined) || raw.lengthOk;
      const representative = refined
        ? checkPose(
            poseAt(scene.carts.A, scene.carts.B, repU, repB),
            scene.beamLength,
            scene.beamRadius,
            0.002,
            scene.edges,
          )
        : raw;
      const gateCheck = checkPose(
        poseAt(scene.carts.A, scene.carts.B, repU, repB),
        scene.beamLength,
        scene.beamRadius,
        0.002,
        gateEdges,
      );
      row.push({
        i,
        j,
        uA,
        uB,
        lengthError: representative.lengthError,
        rigidBin,
        repU,
        repB,
        gateSafe: rigidBin && gateCheck.safe,
        fullSafe: rigidBin && representative.safe,
        grazed: gateCheck.grazed.length > 0,
        blockedSeal: gateCheck.edges.some((e) => e.policy === "sealed" && e.violated),
        blockedWall: gateCheck.edges.some((e) => e.policy === "graze-ok" && e.violated),
        raw: representative,
      });
    }
    rows.push(row);
  }
  return rows;
}

interface GridNode {
  i: number;
  j: number;
  uA: number;
  uB: number;
}

function buildValidGrid(scene: SceneCard): { valid: Uint8Array; nodes: GridNode[] } {
  const n = PLAN_N;
  const valid = new Uint8Array(n * n);
  const nodes: GridNode[] = [];
  for (let j = 0; j < n; j += 1) {
    for (let i = 0; i < n; i += 1) {
      const uA = i / (n - 1);
      const uB = j / (n - 1);
      const pose = poseAt(scene.carts.A, scene.carts.B, uA, uB);
      const check = checkPose(
        pose,
        scene.beamLength,
        scene.beamRadius,
        GRID_LENGTH_TOLERANCE,
        scene.edges,
      );
      if (check.safe) {
        valid[j * n + i] = 1;
        nodes.push({ i, j, uA, uB });
      }
    }
  }
  return { valid, nodes };
}

interface SearchResult {
  path: GridNode[] | null;
  arrival: number;
  checkedEdges: number;
}

function segmentBoundaries(cart: SceneCard["carts"][EndId]): number[] {
  const total = pathLength(cart);
  let distance = 0;
  const values = [0];
  for (const segment of cart.path) {
    const length =
      segment.kind === "line"
        ? Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
        : segment.radius * Math.abs(segment.deltaAngle);
    distance += length;
    values.push(clamp(distance / total, 0, 1));
  }
  return values;
}

/**
 * 在两段轨迹的分段边界构成的小规模进度图上求干净关键帧。
 * 每条边都不跨越任一车的变速分段，因此关键帧之间可用恒定弧长速度。
 */
function solveBoundaryPlan(scene: SceneCard): Plan | null {
  const boundsA = segmentBoundaries(scene.carts.A);
  const boundsB = segmentBoundaries(scene.carts.B);
  const na = boundsA.length;
  const nb = boundsB.length;
  const count = na * nb;
  const inf = Number.POSITIVE_INFINITY;
  const dist = new Float64Array(count).fill(inf);
  const prev = new Int32Array(count).fill(-1);
  const done = new Uint8Array(count);
  const idOf = (ia: number, ib: number) => ib * na + ia;
  const start = idOf(0, 0);
  const goal = idOf(na - 1, nb - 1);

  for (let ib = 0; ib < nb; ib += 1) {
    for (let ia = 0; ia < na; ia += 1) {
      const pose = poseAt(scene.carts.A, scene.carts.B, boundsA[ia], boundsB[ib]);
      const check = checkPose(pose, scene.beamLength, scene.beamRadius, 0.012, scene.edges);
      if (!check.safe) done[idOf(ia, ib)] = 2; // 永久排除
    }
  }
  if (done[start] === 2 || done[goal] === 2) return null;
  dist[start] = 0;

  while (true) {
    let current = -1;
    let best = inf;
    for (let id = 0; id < count; id += 1) {
      if (done[id] !== 1 && done[id] !== 2 && dist[id] < best) {
        best = dist[id];
        current = id;
      }
    }
    if (current === -1) break;
    if (current === goal) {
      const pairs: Array<{ uA: number; uB: number }> = [];
      let id: number = goal;
      while (id !== -1) {
        const ia = id % na;
        const ib = Math.floor(id / na);
        pairs.push({ uA: boundsA[ia], uB: boundsB[ib] });
        if (id === start) break;
        id = prev[id];
      }
      pairs.reverse();

      const frames: Keyframe[] = [
        { t: 0, uA: pairs[0].uA, uB: pairs[0].uB, wait: null, note: "起托" },
      ];
      let time = 0;
      for (let k = 1; k < pairs.length; k += 1) {
        const p0 = pairs[k - 1];
        const p1 = pairs[k];
        const sweep = checkSweep(
          scene.carts.A,
          scene.carts.B,
          p0.uA,
          p1.uA,
          p0.uB,
          p1.uB,
          scene.beamLength,
          scene.beamRadius,
          0.002,
          scene.edges,
          0.01,
        );
        if (!sweep.ok) return null;
        const tA = minimumTravelTime(scene.carts.A, p0.uA, p1.uA);
        const tB = minimumTravelTime(scene.carts.B, p0.uB, p1.uB);
        const dt = Math.max(tA, tB);
        const dA = Math.abs(p1.uA - p0.uA) * pathLength(scene.carts.A);
        const dB = Math.abs(p1.uB - p0.uB) * pathLength(scene.carts.B);
        time += dt;
        frames.push({
          t: time,
          uA: p1.uA,
          uB: p1.uB,
          speedA: dt > 0 ? dA / dt : 0,
          speedB: dt > 0 ? dB / dt : 0,
          wait: dA < 1e-9 ? "A" : dB < 1e-9 ? "B" : null,
          note:
            dA < 1e-9
              ? "甲车停在弧心等待"
              : dB < 1e-9
                ? "乙车停在弧心等待"
                : "两端限速内同步配合",
        });
      }
      return {
        feasible: time <= scene.carts.A.deadline && time <= scene.carts.B.deadline,
        frames,
        arrival: time,
        deadlineA: scene.carts.A.deadline,
        deadlineB: scene.carts.B.deadline,
        slackA: scene.carts.A.deadline - time,
        slackB: scene.carts.B.deadline - time,
        checkedEdges: na * nb,
      };
    }
    done[current] = 1;
    const ia = current % na;
    const ib = Math.floor(current / na);
    const moves: Array<[number, number]> = [[1, 0], [0, 1], [1, 1]];
    for (const [da, db] of moves) {
      const ja = ia + da;
      const jb = ib + db;
      if (ja >= na || jb >= nb) continue;
      const next = idOf(ja, jb);
      if (done[next] === 1 || done[next] === 2) continue;
      const uA0 = boundsA[ia];
      const uB0 = boundsB[ib];
      const uA1 = boundsA[ja];
      const uB1 = boundsB[jb];
      const sweep = checkSweep(
        scene.carts.A,
        scene.carts.B,
        uA0,
        uA1,
        uB0,
        uB1,
        scene.beamLength,
        scene.beamRadius,
        0.002,
        scene.edges,
        0.01,
      );
      if (!sweep.ok) continue;
      const dt = Math.max(
        minimumTravelTime(scene.carts.A, uA0, uA1),
        minimumTravelTime(scene.carts.B, uB0, uB1),
      );
      const candidate = dist[current] + dt;
      if (candidate < dist[next] - 1e-10) {
        dist[next] = candidate;
        prev[next] = current;
      }
    }
  }
  return null;
}

function searchGrid(scene: SceneCard): SearchResult {
  const n = PLAN_N;
  const { valid } = buildValidGrid(scene);
  const start = 0; // (0,0)
  const goal = n * n - 1; // (n-1,n-1)
  if (!valid[start] || !valid[goal]) return { path: null, arrival: Number.POSITIVE_INFINITY, checkedEdges: 0 };

  const inf = Number.POSITIVE_INFINITY;
  const dist = new Float64Array(n * n).fill(inf);
  const prev = new Int32Array(n * n).fill(-1);
  const visited = new Uint8Array(n * n);
  dist[start] = 0;
  let checkedEdges = 0;

  // 稠密网格约 5.8 万点，但有效点只沿刚性配对曲线分布；线性取最小标签即可。
  for (let iter = 0; iter < n * n; iter += 1) {
    let current = -1;
    let best = inf;
    for (let id = 0; id < n * n; id += 1) {
      if (!visited[id] && dist[id] < best) {
        best = dist[id];
        current = id;
      }
    }
    if (current === -1) break;
    if (current === goal) {
      const path: GridNode[] = [];
      let id: number = goal;
      while (id !== -1) {
        const i = id % n;
        const j = Math.floor(id / n);
        path.push({ i, j, uA: i / (n - 1), uB: j / (n - 1) });
        if (id === start) break;
        id = prev[id];
      }
      path.reverse();
      return { path, arrival: dist[goal], checkedEdges };
    }
    visited[current] = 1;
    const ci = current % n;
    const cj = Math.floor(current / n);
    const uA0 = ci / (n - 1);
    const uB0 = cj / (n - 1);

    const moves: Array<[number, number]> = [
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    for (const [di, dj] of moves) {
      const ni = ci + di;
      const nj = cj + dj;
      if (ni >= n || nj >= n) continue;
      const next = nj * n + ni;
      if (visited[next] || !valid[next]) continue;
      const uA1 = ni / (n - 1);
      const uB1 = nj / (n - 1);
      checkedEdges += 1;
      const sweep = checkSweep(
        scene.carts.A,
        scene.carts.B,
        uA0,
        uA1,
        uB0,
        uB1,
        scene.beamLength,
        scene.beamRadius,
        GRID_LENGTH_TOLERANCE,
        scene.edges,
        0.014,
      );
      if (!sweep.ok) continue;
      const tA = minimumTravelTime(scene.carts.A, uA0, uA1);
      const tB = minimumTravelTime(scene.carts.B, uB0, uB1);
      const cost = Math.max(tA, tB);
      const candidate = dist[current] + cost;
      if (candidate < dist[next] - 1e-10) {
        dist[next] = candidate;
        prev[next] = current;
      }
    }
  }
  return { path: null, arrival: inf, checkedEdges };
}

export function solvePlan(scene: SceneCard = SCENE): Plan {
  return solveBoundaryPlan(scene) ?? solveDensePlan(scene);
}

function solveDensePlan(scene: SceneCard): Plan {
  const search = searchGrid(scene);
  const deadlineA = scene.carts.A.deadline;
  const deadlineB = scene.carts.B.deadline;
  if (!search.path || search.path.length < 2) {
    return {
      feasible: false,
      reason: "稠密进度网格中找不到连续、刚性且全程不碰的单调路径。",
      frames: [],
      arrival: Number.POSITIVE_INFINITY,
      deadlineA,
      deadlineB,
      slackA: Number.NEGATIVE_INFINITY,
      slackB: Number.NEGATIVE_INFINITY,
      checkedEdges: search.checkedEdges,
    };
  }

  const frames: Keyframe[] = [];
  let t = 0;
  frames.push({ t: 0, uA: search.path[0].uA, uB: search.path[0].uB, wait: null, note: "起托" });
  for (let k = 1; k < search.path.length; k += 1) {
    const p0 = search.path[k - 1];
    const p1 = search.path[k];
    const tA = minimumTravelTime(scene.carts.A, p0.uA, p1.uA);
    const tB = minimumTravelTime(scene.carts.B, p0.uB, p1.uB);
    const dt = Math.max(tA, tB);
    const dA = Math.abs(p1.uA - p0.uA) * pathLength(scene.carts.A);
    const dB = Math.abs(p1.uB - p0.uB) * pathLength(scene.carts.B);
    t += dt;
    frames.push({
      t,
      uA: p1.uA,
      uB: p1.uB,
      speedA: dt > 0 ? dA / dt : 0,
      speedB: dt > 0 ? dB / dt : 0,
      wait: dA < 1e-9 ? "A" : dB < 1e-9 ? "B" : null,
    });
  }

  const arrival = t;
  const feasible = arrival <= deadlineA && arrival <= deadlineB;
  return {
    feasible,
    reason: feasible ? undefined : `最早同时到货 ${arrival.toFixed(2)}s，超过至少一张截止时刻。`,
    frames,
    arrival,
    deadlineA,
    deadlineB,
    slackA: deadlineA - arrival,
    slackB: deadlineB - arrival,
    checkedEdges: search.checkedEdges,
  };
}

export function progressAtEarliestTime(cart: SceneCard["carts"][EndId], time: number): number {
  let remaining = Math.max(0, time);
  let distance = 0;
  for (const segment of cart.path) {
    const length =
      segment.kind === "line"
        ? Math.hypot(segment.b.x - segment.a.x, segment.b.y - segment.a.y)
        : segment.radius * Math.abs(segment.deltaAngle);
    const duration = length / segment.speed;
    if (remaining <= duration) {
      distance += length * clamp(remaining / duration, 0, 1);
      return distance / pathLength(cart);
    }
    remaining -= duration;
    distance += length;
  }
  return 1;
}

export interface NaiveFailure {
  time: number;
  uA: number;
  uB: number;
  gateId: string;
  gateName: string;
  check: PoseCheck;
  lengthError: number;
}

/** 把两端各自按最高速度跑完的“最顺一遍”硬拼到同一时钟上，找出首个窄口失败。 */
export function findNaiveFailure(scene: SceneCard = SCENE): NaiveFailure | null {
  const duration = Math.max(
    minimumTravelTime(scene.carts.A, 0, 1),
    minimumTravelTime(scene.carts.B, 0, 1),
  );
  const dt = 0.02;
  for (let time = 0; time <= duration + dt; time += dt) {
    const uA = progressAtEarliestTime(scene.carts.A, time);
    const uB = progressAtEarliestTime(scene.carts.B, time);
    for (const gate of scene.gates) {
      const edges = scene.edges.filter((edge) => gate.edgeIds.includes(edge.id));
      const pose = poseAt(scene.carts.A, scene.carts.B, uA, uB);
      const check = checkPose(
        pose,
        scene.beamLength,
        scene.beamRadius,
        scene.lengthTolerance,
        edges,
      );
      if (!check.safe) {
        return {
          time,
          uA,
          uB,
          gateId: gate.id,
          gateName: gate.name,
          check,
          lengthError: check.lengthError,
        };
      }
    }
  }
  return null;
}

export function pairAtPlanTime(plan: Plan, time: number): { uA: number; uB: number; frameIndex: number } {
  if (plan.frames.length === 0) return { uA: 0, uB: 0, frameIndex: 0 };
  const t = clamp(time, 0, plan.arrival);
  let index = 0;
  while (index < plan.frames.length - 1 && plan.frames[index + 1].t < t) index += 1;
  const f0 = plan.frames[index];
  const f1 = plan.frames[Math.min(index + 1, plan.frames.length - 1)];
  const span = f1.t - f0.t;
  const q = span <= 1e-9 ? 0 : clamp((t - f0.t) / span, 0, 1);
  return {
    uA: f0.uA + (f1.uA - f0.uA) * q,
    uB: f0.uB + (f1.uB - f0.uB) * q,
    frameIndex: index,
  };
}

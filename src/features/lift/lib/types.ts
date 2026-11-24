export type EndId = "A" | "B";

export interface Vec {
  x: number;
  y: number;
}

export interface LineSegmentSpec {
  id: string;
  kind: "line";
  a: Vec;
  b: Vec;
  /** 分段速度上限，米/秒 */
  speed: number;
  label?: string;
}

export interface ArcSegmentSpec {
  id: string;
  kind: "arc";
  center: Vec;
  radius: number;
  startAngle: number;
  /** 有符号扫角；正角为逆时针（数学坐标 y 向上） */
  deltaAngle: number;
  speed: number;
  label?: string;
}

export type PathSegment = LineSegmentSpec | ArcSegmentSpec;

export interface CartCard {
  id: EndId;
  name: string;
  short: string;
  color: string;
  deadline: number;
  path: PathSegment[];
}

export type EdgePolicy = "graze-ok" | "sealed";

export interface WallEdge {
  id: string;
  gateId?: string;
  name: string;
  a: Vec;
  b: Vec;
  policy: EdgePolicy;
  /** 障碍条半厚；碰撞距离为梁半径 + 此值 */
  halfThickness: number;
  /** 装饰/判定优先级 */
  tone?: "wall" | "seal" | "guide";
}

export interface NarrowGate {
  id: string;
  index: number;
  name: string;
  at: Vec;
  hint: string;
  edgeIds: string[];
  progressWindow?: { uA: [number, number]; uB: [number, number] };
}

export interface SceneCard {
  id: string;
  title: string;
  subtitle: string;
  beamLength: number;
  beamRadius: number;
  lengthTolerance: number;
  carts: Record<EndId, CartCard>;
  edges: WallEdge[];
  gates: NarrowGate[];
  delivery: { a: Vec; b: Vec };
}

export interface Pose {
  a: Vec;
  b: Vec;
}

export interface EdgeClearance {
  edgeId: string;
  name: string;
  policy: EdgePolicy;
  distance: number;
  requiredDistance: number;
  /** distance - requiredDistance；0 为恰好擦边，负数为侵入 */
  clearance: number;
  violated: boolean;
  contact: boolean;
}

export interface PoseCheck {
  length: number;
  lengthError: number;
  lengthOk: boolean;
  edges: EdgeClearance[];
  safe: boolean;
  grazed: string[];
  sealedTouched: string[];
  collisions: string[];
}

export interface Keyframe {
  t: number;
  uA: number;
  uB: number;
  /** 从上一关键帧到本帧，两端实际采用的速度（米/秒） */
  speedA?: number;
  speedB?: number;
  wait?: EndId | "both" | null;
  note?: string;
}

export interface Plan {
  feasible: boolean;
  reason?: string;
  frames: Keyframe[];
  arrival: number;
  deadlineA: number;
  deadlineB: number;
  slackA: number;
  slackB: number;
  distance?: number;
  checkedEdges?: number;
}

export interface ComboCell {
  i: number;
  j: number;
  uA: number;
  uB: number;
  lengthError: number;
  rigidBin: boolean;
  repU: number;
  repB: number;
  gateSafe: boolean;
  fullSafe: boolean;
  grazed: boolean;
  blockedSeal: boolean;
  blockedWall: boolean;
  raw: PoseCheck;
}

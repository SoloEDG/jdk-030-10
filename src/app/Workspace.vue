<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import ComboMatrix from "@/features/lift/ui/ComboMatrix.vue";
import StageSvg from "@/features/lift/ui/StageSvg.vue";
import { SCENE } from "@/features/lift/lib/card";
import {
  buildMatrix,
  findNaiveFailure,
  pairAtPlanTime,
  progressAtEarliestTime,
  solvePlan,
  MATRIX_N,
} from "@/features/lift/lib/planner";
import { checkPose, checkSweep, minimumTravelTime, pathLength, pointAtProgress } from "@/features/lift/lib/geometry";
import type { ComboCell, Keyframe } from "@/features/lift/lib/types";

const scene = SCENE;
const plan = shallowRef(solvePlan(scene));
const naiveFailure = shallowRef(findNaiveFailure(scene));
const matrices = shallowRef(
  Object.fromEntries(scene.gates.map((gate) => [gate.id, buildMatrix(scene, gate.id)])),
);

const clock = ref(0);
const playing = ref(false);
const rate = ref(2);
const runKind = ref<"plan" | "naive">("plan");
const matrixGateId = ref<string>("gate-1");
const highlightGateId = ref<string>("gate-1");
const hoverCell = ref<ComboCell | null>(null);
const noticeTone = ref<"info" | "success" | "warn" | "danger">("info");
const notice = ref("已求出一次经过连续扫掠验证的配合。可播放、拨到中段，或在第一窄口查看进度组合。");
const receipt = ref<{ at: string; fingerprint: string; arrival: number } | null>(null);
const matrixSection = ref<HTMLElement | null>(null);

let raf = 0;
let lastTs = 0;

const matrixGate = computed(() => scene.gates.find((gate) => gate.id === matrixGateId.value) ?? scene.gates[0]);
const matrix = computed<ComboCell[][]>(() => matrices.value[matrixGateId.value] ?? matrices.value["gate-1"]);
watch(matrixGateId, (id) => {
  highlightGateId.value = id;
});
const duration = computed(() => (runKind.value === "naive" ? naiveFailure.value?.time ?? 0 : plan.value.arrival));

const pair = computed(() => {
  if (runKind.value === "naive" && naiveFailure.value) {
    return {
      uA: progressAtEarliestTime(scene.carts.A, clock.value),
      uB: progressAtEarliestTime(scene.carts.B, clock.value),
      frameIndex: -1,
    };
  }
  return pairAtPlanTime(plan.value, clock.value);
});

const pose = computed(() => ({
  a: {
    x: pointAt("A", pair.value.uA).x,
    y: pointAt("A", pair.value.uA).y,
  },
  b: pointAt("B", pair.value.uB),
}));

function pointAt(end: "A" | "B", u: number) {
  return pointAtProgress(scene.carts[end], u);
}

const poseCheck = computed(() =>
  checkPose(pose.value, scene.beamLength, scene.beamRadius, scene.lengthTolerance, scene.edges),
);

const ruleChecks = computed(() => {
  const halfThickness = 0.1;
  const requiredDistance = scene.beamRadius + halfThickness;
  const edgeBase = {
    id: "self-test-edge",
    name: "自检边",
    a: { x: -1, y: -requiredDistance },
    b: { x: 3, y: -requiredDistance },
    halfThickness,
  } as const;
  const beam = { a: { x: 0, y: 0 }, b: { x: 2, y: 0 } };
  const graze = checkPose(beam, 2, scene.beamRadius, 0.0001, [{ ...edgeBase, policy: "graze-ok" }]);
  const seal = checkPose(beam, 2, scene.beamRadius, 0.0001, [{ ...edgeBase, policy: "sealed" }]);
  return [
    { id: "graze", label: "靠墙通行边：恰好擦边放行", pass: graze.safe && graze.grazed.length > 0 },
    { id: "seal", label: "封条边：接触即判不可行", pass: !seal.safe && seal.sealedTouched.length > 0 },
  ];
});

const planVerification = computed(() => {
  for (let index = 0; index < plan.value.frames.length - 1; index += 1) {
    const p0 = plan.value.frames[index];
    const p1 = plan.value.frames[index + 1];
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
      0.008,
    );
    if (!sweep.ok) return { ok: false, text: `第 ${index + 1} 段连续扫掠未通过` };
    const dt = p1.t - p0.t;
    if (p1.uA + 1e-9 < p0.uA || p1.uB + 1e-9 < p0.uB) {
      return { ok: false, text: `第 ${index + 1} 段出现后退` };
    }
    const minimum = Math.max(
      minimumTravelTime(scene.carts.A, p0.uA, p1.uA),
      minimumTravelTime(scene.carts.B, p0.uB, p1.uB),
    );
    if (dt + 1e-6 < minimum) return { ok: false, text: `第 ${index + 1} 段超过速度上限` };
  }
  const last = plan.value.frames[plan.value.frames.length - 1];
  const a = pointAtProgress(scene.carts.A, last.uA);
  const b = pointAtProgress(scene.carts.B, last.uB);
  const endpointOk =
    Math.hypot(a.x - scene.delivery.a.x, a.y - scene.delivery.a.y) < 1e-6 &&
    Math.hypot(b.x - scene.delivery.b.x, b.y - scene.delivery.b.y) < 1e-6;
  return {
    ok: endpointOk,
    text: endpointOk ? "单调、限速、连续扫掠与终态对齐均校验通过" : "终态未对齐交付点",
  };
});

const currentI = computed(() => Math.round(pair.value.uA * (MATRIX_N - 1)));
const currentJ = computed(() => Math.round(pair.value.uB * (MATRIX_N - 1)));
const showCurrentI = computed(() => (runKind.value === "plan" ? currentI.value : -1));
const showCurrentJ = computed(() => (runKind.value === "plan" ? currentJ.value : -1));
const activeFrame = computed<Keyframe | null>(() => {
  if (runKind.value !== "plan" || pair.value.frameIndex < 0) return null;
  return plan.value.frames[pair.value.frameIndex + 1] ?? plan.value.frames[pair.value.frameIndex] ?? null;
});

const planFingerprint = computed(() => {
  const last = plan.value.frames[plan.value.frames.length - 1];
  return `DUAL-030 · ${plan.value.frames.length}KEY · ${plan.value.arrival.toFixed(2)}s · ${last.uA.toFixed(6)}/${last.uB.toFixed(6)}`;
});
const currentFingerprint = computed(
  () => `t=${clock.value.toFixed(2)} · 甲${(pair.value.uA * 100).toFixed(2)}% · 乙${(pair.value.uB * 100).toFixed(2)}%`,
);
const atReceiptPose = computed(() => runKind.value === "plan" && clock.value >= plan.value.arrival - 0.002);
const receiptMatches = computed(
  () => receipt.value?.fingerprint === planFingerprint.value && atReceiptPose.value,
);

const progressA = computed(() => pair.value.uA * 100);
const progressB = computed(() => pair.value.uB * 100);
const distanceA = computed(() => pair.value.uA * pathLength(scene.carts.A));
const distanceB = computed(() => pair.value.uB * pathLength(scene.carts.B));

const nearPassBands = computed(() => {
  const gate = matrixGate.value;
  const result: Array<{ j: number; labelB: string; range: string; count: number }> = [];
  matrix.value.forEach((row, j) => {
    const good = row.filter((cell) => {
      if (!cell.gateSafe || !cell.rigidBin) return false;
      const window = gate.progressWindow;
      if (
        window &&
        (cell.repU < window.uA[0] || cell.repU > window.uA[1] || cell.repB < window.uB[0] || cell.repB > window.uB[1])
      ) {
        return false;
      }
      const minClearance = Math.min(
        ...cell.raw.edges
          .filter((edge) => gate.edgeIds.includes(edge.edgeId))
          .map((edge) => Math.abs(edge.clearance)),
      );
      return minClearance < 0.9;
    });
    if (good.length > 0) {
      const is = good.map((cell) => cell.i);
      const iMin = Math.min(...is);
      const iMax = Math.max(...is);
      result.push({
        j,
        labelB: `${(good[0].uB * 100).toFixed(1)}%`,
        range: `甲 ${(matrix.value[j][iMin].uA * 100).toFixed(1)}–${(matrix.value[j][iMax].uA * 100).toFixed(1)}%`,
        count: good.length,
      });
    }
  });
  return result.reverse();
});

function setNotice(tone: typeof noticeTone.value, message: string) {
  noticeTone.value = tone;
  notice.value = message;
}

function playPlan() {
  runKind.value = "plan";
  clock.value = 0;
  playing.value = true;
  receipt.value = null;
  highlightGateId.value = "gate-1";
  setNotice("info", "正式配合已开始：所有关键帧之间都做过刚性长度与连续扫掠校验。");
}

function tryNaiveStitch() {
  if (!naiveFailure.value) return;
  runKind.value = "naive";
  clock.value = 0;
  playing.value = true;
  receipt.value = null;
  matrixGateId.value = naiveFailure.value.gateId;
  highlightGateId.value = naiveFailure.value.gateId;
  setNotice("warn", "正在把两端各自最高速的一遍硬拼到同一时钟；将在第一处窄口自动停下。");
}

function togglePlay() {
  if (clock.value >= duration.value - 0.01) clock.value = 0;
  playing.value = !playing.value;
  lastTs = 0;
}

function resetClock() {
  playing.value = false;
  clock.value = 0;
  setNotice("info", "已回到同一遍配合的起点；端点状态由同一时钟导出。");
}

function scrubMiddle() {
  playing.value = false;
  clock.value = duration.value / 2;
  setNotice("info", "已手动拨到中段。舞台、读数和后续签收仍使用同一个进度对。");
}

function onScrub(value: number) {
  playing.value = false;
  clock.value = value;
}

function locateGateOne() {
  runKind.value = "plan";
  playing.value = false;
  matrixGateId.value = "gate-1";
  highlightGateId.value = "gate-1";
  // 第二关键帧是通过第一横缝的平梁横移段；取该段中央。
  const f1 = plan.value.frames[2];
  const f2 = plan.value.frames[3];
  clock.value = f1 && f2 ? (f1.t + f2.t) / 2 : 0;
  matrixSection.value?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  setNotice("info", "已停在第一窄口。矩阵中绿色进度对可通过该窄口，点击格子会在已验证配合上定位。");
}

function closestPlanTime(uA: number, uB: number): number {
  let bestTime = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let k = 0; k < plan.value.frames.length - 1; k += 1) {
    const p0 = plan.value.frames[k];
    const p1 = plan.value.frames[k + 1];
    const da = p1.uA - p0.uA;
    const db = p1.uB - p0.uB;
    const len2 = da * da + db * db;
    const q = len2 < 1e-12 ? 0.5 : Math.max(0, Math.min(1, ((uA - p0.uA) * da + (uB - p0.uB) * db) / len2));
    const candidateA = p0.uA + da * q;
    const candidateB = p0.uB + db * q;
    const metric = (candidateA - uA) ** 2 + (candidateB - uB) ** 2;
    if (metric < bestDistance) {
      bestDistance = metric;
      bestTime = p0.t + (p1.t - p0.t) * q;
    }
  }
  return bestTime;
}

function selectCombo(cell: ComboCell) {
  runKind.value = "plan";
  playing.value = false;
  clock.value = closestPlanTime(cell.repU, cell.repB);
  highlightGateId.value = matrixGateId.value;
  setNotice(
    cell.gateSafe ? "success" : "danger",
    cell.gateSafe ? "已定位到矩阵组合对应的同一遍连续配合。" : "该格本身不通过；已定位到当前正式配合中最接近的位置供对照。",
  );
}

function signOff() {
  runKind.value = "plan";
  playing.value = false;
  clock.value = plan.value.arrival;
  const last = plan.value.frames[plan.value.frames.length - 1];
  receipt.value = {
    at: new Date().toLocaleString("zh-CN", { hour12: false }),
    fingerprint: planFingerprint.value,
    arrival: plan.value.arrival,
  };
  setNotice("success", `签收成功：终态为甲 ${(last.uA * 100).toFixed(2)}%、乙 ${(last.uB * 100).toFixed(2)}%，与演练终帧一致。`);
}

function tick(ts: number) {
  if (!lastTs) lastTs = ts;
  const dt = Math.min(0.1, (ts - lastTs) / 1000);
  lastTs = ts;
  if (playing.value) {
    clock.value = Math.min(duration.value, clock.value + dt * rate.value);
    if (clock.value >= duration.value - 1e-9) {
      playing.value = false;
      if (runKind.value === "naive" && naiveFailure.value) {
        clock.value = naiveFailure.value.time;
        highlightGateId.value = naiveFailure.value.gateId;
        matrixGateId.value = naiveFailure.value.gateId;
        setNotice("danger", `第一处不可行窄口已停住：${naiveFailure.value.gateName}。红/黄格显示碰撞原因，绿格为还能通过的进度组合。`);
        matrixSection.value?.scrollIntoView?.({ behavior: "smooth", block: "center" });
      } else {
        setNotice("success", "演练已到同时到货时刻。请核对同一对端点后最终签收。");
      }
    }
  }
  raf = requestAnimationFrame(tick);
}

onMounted(() => {
  raf = requestAnimationFrame(tick);
});
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <div class="lift-app" data-testid="lift-workshop">
    <header class="lift-header">
      <div>
        <p class="eyebrow">双机抬件规划台 · 刚性长梁连续碰撞求解</p>
        <h1>{{ scene.title }}</h1>
        <p class="subtitle">{{ scene.subtitle }}；梁长 {{ scene.beamLength.toFixed(2) }} m，进度图分辨率 {{ MATRIX_N }}×{{ MATRIX_N }}。</p>
      </div>
      <div class="header-actions">
        <button type="button" class="primary" data-testid="solve-plan" @click="playPlan">求解并演练正式配合</button>
        <button type="button" class="danger" data-testid="naive-run" title="把两端各自最快的一遍硬拼到同一时钟，遇到第一处不可行窄口自动停下" @click="tryNaiveStitch">试凑各自最快一遍（在第一不可行窄口停）</button>
        <button type="button" data-testid="first-gate" title="暂停在第一处窄口并查看还能通过的进度组合" @click="locateGateOne">停到第一窄口看组合</button>
      </div>
    </header>

    <p class="global-notice" :data-tone="noticeTone" role="status">{{ notice }}</p>

    <main class="layout">
      <section class="stage-panel panel">
        <div class="stage-toolbar">
          <div class="run-switch">
            <span class="run-badge" :data-kind="runKind" data-testid="run-kind">
              {{ runKind === "plan" ? "同一遍已验证配合" : "反例：硬拼各自最快" }}
            </span>
            <label class="rate">
              速度
              <select v-model.number="rate" aria-label="演练播放速度">
                <option :value="0.5">0.5×</option>
                <option :value="1">1×</option>
                <option :value="2">2×</option>
                <option :value="4">4×</option>
              </select>
            </label>
          </div>
          <div class="play-controls">
            <button type="button" @click="resetClock">回起点</button>
            <button type="button" class="primary" data-testid="play-pause" @click="togglePlay">
              {{ playing ? "暂停" : clock >= duration - 0.01 ? "重播" : "播放" }}
            </button>
            <button type="button" data-testid="middle-button" @click="scrubMiddle">手动拨到中段</button>
          </div>
        </div>

        <StageSvg
          :scene="scene"
          :u-a="pair.uA"
          :u-b="pair.uB"
          :check="poseCheck"
          :run-kind="runKind"
          :active-gate-id="highlightGateId"
          :ghost="hoverCell ? { uA: hoverCell.repU, uB: hoverCell.repB } : null"
        />

        <div class="scrub-row">
          <span>{{ clock.toFixed(2) }}s</span>
          <input
            type="range"
            min="0"
            :max="duration"
            step="0.01"
            :value="clock"
            data-testid="timeline-scrub"
            aria-label="同一遍配合的时间轴"
            @input="onScrub(Number(($event.target as HTMLInputElement).value))"
          />
          <span>/ {{ duration.toFixed(2) }}s</span>
        </div>

        <div class="endpoint-grid" data-testid="endpoint-readout">
          <article class="endpoint-card a">
            <h2>甲车 / 梁端甲</h2>
            <p><b>{{ progressA.toFixed(2) }}%</b><span>{{ distanceA.toFixed(2) }} m</span></p>
            <small>坐标 ({{ pose.a.x.toFixed(2) }}, {{ pose.a.y.toFixed(2) }})</small>
            <div class="bar"><i :style="{ width: `${progressA}%` }" /></div>
          </article>
          <article class="endpoint-card b">
            <h2>乙车 / 梁端乙</h2>
            <p><b>{{ progressB.toFixed(2) }}%</b><span>{{ distanceB.toFixed(2) }} m</span></p>
            <small>坐标 ({{ pose.b.x.toFixed(2) }}, {{ pose.b.y.toFixed(2) }})</small>
            <div class="bar"><i :style="{ width: `${progressB}%` }" /></div>
          </article>
          <article class="beam-card" :data-safe="poseCheck.safe">
            <h2>刚性梁 / 碰撞</h2>
            <p><b>{{ poseCheck.length.toFixed(3) }} m</b><span>误差 {{ (poseCheck.lengthError * 100).toFixed(2) }} cm</span></p>
            <small v-if="poseCheck.safe">当前姿态与连续计划一致，无碰撞</small>
            <small v-else>碰撞：{{ poseCheck.collisions.join("、") || "梁长不符" }}</small>
            <small v-if="poseCheck.grazed.length">允许擦边：{{ poseCheck.grazed.join("、") }}</small>
          </article>
        </div>
      </section>

      <aside class="right-column">
        <section class="panel deadline-panel">
          <h2>截止时刻与同时到货</h2>
          <div class="deadline-grid">
            <div>
              <span>甲截止</span>
              <b>{{ scene.carts.A.deadline.toFixed(0) }}s</b>
              <em :class="{ bad: plan.slackA < 0 }">余 {{ plan.slackA.toFixed(2) }}s</em>
            </div>
            <div>
              <span>乙截止</span>
              <b>{{ scene.carts.B.deadline.toFixed(0) }}s</b>
              <em :class="{ bad: plan.slackB < 0 }">余 {{ plan.slackB.toFixed(2) }}s</em>
            </div>
            <div class="arrival">
              <span>共同到货</span>
              <b data-testid="arrival-time">{{ plan.arrival.toFixed(2) }}s</b>
              <em class="ok">可行</em>
            </div>
          </div>
          <p class="fingerprint" data-testid="plan-fingerprint">{{ planFingerprint }}</p>
          <p class="fingerprint live">
            {{ currentFingerprint }}
            <template v-if="activeFrame?.speedA !== undefined">
              · 甲 {{ (activeFrame.speedA ?? 0).toFixed(2) }}m/s / 乙 {{ (activeFrame.speedB ?? 0).toFixed(2) }}m/s
            </template>
          </p>
        </section>

        <section ref="matrixSection" class="panel matrix-panel">
          <div class="panel-title-row">
            <h2>窄口进度组合</h2>
            <select v-model="matrixGateId" aria-label="选择窄口">
              <option v-for="gate in scene.gates" :key="gate.id" :value="gate.id">第{{ gate.index }}处</option>
            </select>
          </div>
          <p class="gate-hint">{{ matrixGate.name }}：{{ matrixGate.hint }}</p>
          <ComboMatrix
            :matrix="matrix"
            :gate="matrixGate"
            :current-i="showCurrentI"
            :current-j="showCurrentJ"
            :naive-i="runKind === 'naive' ? currentI : undefined"
            :naive-j="runKind === 'naive' ? currentJ : undefined"
            @select="selectCombo"
            @hover="hoverCell = $event"
          />
          <div class="legend matrix-legend">
            <span><i data-state="pass-near" />可通过</span>
            <span><i data-state="current" />本遍位置</span>
            <span><i data-state="naive" />硬拼失败</span>
            <span><i data-state="seal" />碰封条</span>
            <span><i data-state="wall" />侵擦边墙</span>
            <span><i data-state="length" />梁长不符</span>
          </div>
          <div class="bands" data-testid="combo-bands">
            <h3>仍可通过的进度行</h3>
            <p v-if="nearPassBands.length === 0" class="empty">当前筛选下没有近窄口可行格。</p>
            <ul>
              <li v-for="band in nearPassBands.slice(0, 14)" :key="band.j">
                <b>乙 {{ band.labelB }}</b><span>{{ band.range }}</span>
              </li>
            </ul>
          </div>
        </section>
      </aside>
    </main>

    <section class="bottom-grid">
      <section class="panel schedule-panel">
        <h2>同一遍连续配合的关键帧</h2>
        <p class="schedule-note" data-testid="monotonic-note">
          全部相邻帧满足 Δu<sub>甲</sub> ≥ 0、Δu<sub>乙</sub> ≥ 0；实际速度不超过分段上限，等待只放在两个弧心安全位。
        </p>
        <ol class="frame-list" data-testid="frame-list">
          <li
            v-for="(frame, index) in plan.frames"
            :key="index"
            :data-active="runKind === 'plan' && pair.frameIndex === index - 1"
          >
            <span class="time">{{ frame.t.toFixed(2) }}s</span>
            <span class="progress">甲 {{ (frame.uA * 100).toFixed(1) }}% · 乙 {{ (frame.uB * 100).toFixed(1) }}%</span>
            <span class="speed">
              {{ frame.speedA ? `甲 ${frame.speedA.toFixed(2)}m/s` : "甲等待" }} /
              {{ frame.speedB ? `乙 ${frame.speedB.toFixed(2)}m/s` : "乙等待" }}
            </span>
            <em>{{ frame.note }}</em>
          </li>
        </ol>
      </section>

      <section class="panel card-panel">
        <h2>搬运卡分段速度上限</h2>
        <div v-for="cart in [scene.carts.A, scene.carts.B]" :key="cart.id" class="cart-card-line">
          <h3 :style="{ color: cart.color }">{{ cart.name }} · 截止 {{ cart.deadline }}s</h3>
          <ul>
            <li v-for="segment in cart.path" :key="segment.id">
              <span>{{ segment.label ?? segment.kind }}</span>
              <b>≤ {{ segment.speed.toFixed(2) }} m/s</b>
            </li>
          </ul>
        </div>
      </section>

      <section class="panel receipt-panel">
        <h2>演练 / 中段 / 签收一致性</h2>
        <p :data-testid="`plan-verification-${planVerification.ok ? 'ok' : 'bad'}`" class="verify">
          {{ planVerification.ok ? "✓" : "✕" }} {{ planVerification.text }}
        </p>
        <ul class="rule-checks" data-testid="rule-checks">
          <li v-for="rule in ruleChecks" :key="rule.id" :data-pass="rule.pass">
            {{ rule.pass ? "✓" : "✕" }} {{ rule.label }}
          </li>
        </ul>
        <p>舞台、时间轴拨杆与读数都由同一个 <code>(uA(t), uB(t))</code> 导出；不存在把两端各自最顺记录拼接起来的第二状态。</p>
        <button type="button" class="primary" data-testid="signoff-button" @click="signOff">定位终态并最终签收</button>
        <div v-if="receipt" class="receipt" data-testid="signoff-receipt" :data-match="receiptMatches">
          <h3>签收单</h3>
          <p>签收时间：{{ receipt.at }}</p>
          <p>配合编号：{{ receipt.fingerprint }}</p>
          <p>到货时刻：{{ receipt.arrival.toFixed(2) }}s</p>
          <p>端点：甲 100.00% {{ scene.delivery.a.x }},{{ scene.delivery.a.y }}；乙 100.00% {{ scene.delivery.b.x }},{{ scene.delivery.b.y }}</p>
          <p :class="receiptMatches ? 'ok' : 'warn'">
            {{ receiptMatches ? "当前拨杆就在签收端点，三端记录一致。" : "拨杆已离开签收端点；签收单仍锁定终帧，可点上方按钮返回。" }}
          </p>
        </div>
      </section>
    </section>
  </div>
</template>

<style scoped>
.lift-app {
  max-width: 1560px;
  margin: 0 auto;
  padding: 18px 22px 40px;
}
.lift-header {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  align-items: flex-end;
  border-bottom: 1px solid var(--line);
  padding-bottom: 16px;
}
.eyebrow {
  color: var(--brass);
  letter-spacing: 0.18em;
  font-size: 12px;
  margin: 0 0 6px;
}
h1 {
  margin: 0;
  font-size: clamp(24px, 3vw, 38px);
  letter-spacing: 0.08em;
}
.subtitle {
  margin: 8px 0 0;
  opacity: 0.76;
  line-height: 1.6;
}
.header-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
button,
select {
  background: #1a140f;
  border: 1px solid var(--line);
  color: var(--paper);
  padding: 8px 12px;
  border-radius: 2px;
  cursor: pointer;
}
button:hover,
select:hover {
  border-color: var(--brass);
}
button.primary {
  background: #7c5a2e;
  border-color: var(--brass);
  color: #fff7e8;
  font-weight: 700;
}
button.danger {
  border-color: #a33a2a;
  color: #ffd8cc;
}
.global-notice {
  margin: 14px 0;
  padding: 10px 14px;
  border: 1px solid var(--line);
  background: #1a140f;
  line-height: 1.5;
}
.global-notice[data-tone="success"] {
  border-color: #4f8a5b;
  color: #bde7c4;
}
.global-notice[data-tone="warn"] {
  border-color: #c47b2c;
  color: #ffd39a;
}
.global-notice[data-tone="danger"] {
  border-color: #d44b36;
  color: #ffc5b8;
}
.layout {
  display: grid;
  grid-template-columns: minmax(0, 1.75fr) minmax(360px, 0.9fr);
  gap: 16px;
  align-items: start;
}
.panel {
  background: rgba(36, 27, 20, 0.94);
  border: 1px solid var(--line);
  padding: 14px;
  border-radius: 4px;
}
.stage-toolbar {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.run-switch,
.play-controls {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.run-badge {
  padding: 5px 9px;
  border: 1px solid #5d7c63;
  color: #bde7c4;
  font-size: 13px;
}
.run-badge[data-kind="naive"] {
  border-color: #d44b36;
  color: #ffc5b8;
}
.rate {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  opacity: 0.85;
}
:deep(.stage-svg) {
  width: 100%;
  height: auto;
  display: block;
  border: 1px solid rgba(201, 163, 106, 0.35);
  background: #f3ead8;
  border-radius: 3px;
}
.scrub-row {
  display: grid;
  grid-template-columns: 54px 1fr 64px;
  gap: 10px;
  align-items: center;
  margin: 12px 0;
  font-variant-numeric: tabular-nums;
}
.scrub-row input {
  width: 100%;
  accent-color: var(--brass);
}
.endpoint-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
.endpoint-card,
.beam-card {
  border: 1px solid var(--line);
  background: #1a140f;
  padding: 10px;
  min-width: 0;
}
.endpoint-card h2,
.beam-card h2,
.panel h2 {
  margin: 0 0 8px;
  font-size: 13px;
  letter-spacing: 0.12em;
  color: var(--brass);
}
.endpoint-card p,
.beam-card p {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin: 0 0 5px;
}
.endpoint-card b {
  font-size: 22px;
}
.endpoint-card.a b {
  color: #fb923c;
}
.endpoint-card.b b {
  color: #22d3ee;
}
.endpoint-card small,
.beam-card small {
  display: block;
  opacity: 0.72;
  line-height: 1.4;
  font-size: 12px;
}
.bar {
  height: 5px;
  background: #3a2d20;
  margin-top: 8px;
}
.bar i {
  display: block;
  height: 100%;
  background: currentColor;
}
.endpoint-card.a .bar i {
  background: #f97316;
}
.endpoint-card.b .bar i {
  background: #0891b2;
}
.beam-card[data-safe="false"] {
  border-color: #d44b36;
}
.right-column {
  display: grid;
  gap: 16px;
}
.deadline-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.deadline-grid div {
  border: 1px solid var(--line);
  padding: 8px;
  background: #1a140f;
}
.deadline-grid span {
  display: block;
  font-size: 12px;
  opacity: 0.7;
}
.deadline-grid b {
  display: block;
  font-size: 22px;
  margin: 3px 0;
}
.deadline-grid em {
  font-style: normal;
  font-size: 12px;
  color: #9bd6a5;
}
.deadline-grid em.bad {
  color: #ff8b78;
}
.fingerprint {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  opacity: 0.78;
  margin: 10px 0 0;
  overflow-wrap: anywhere;
}
.fingerprint.live {
  color: #bde7c4;
}
.panel-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.panel-title-row h2 {
  margin: 0;
}
.gate-hint {
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.78;
  margin: 8px 0 10px;
}
:deep(.matrix-wrap) {
  width: 100%;
}
:deep(.matrix-grid) {
  display: grid;
  gap: 1px;
  width: 100%;
  aspect-ratio: 1;
  background: #0d0a08;
  border: 1px solid var(--line);
}
:deep(.combo-cell) {
  all: unset;
  display: block;
  min-width: 0;
  min-height: 0;
  cursor: crosshair;
  background: #3a2d20;
  border: none;
  border-radius: 0;
}
:deep(.combo-cell[data-state="length"]) {
  background: #2b231b;
}
:deep(.combo-cell[data-state="pass"]) {
  background: #2f6b43;
  opacity: 0.45;
}
:deep(.combo-cell[data-state="pass-near"]) {
  background: #55d17a;
  box-shadow: inset 0 0 0 0.5px rgba(255, 255, 255, 0.25);
}
:deep(.combo-cell[data-state="seal"]) {
  background: #c83f2b;
}
:deep(.combo-cell[data-state="wall"]) {
  background: #d69a2d;
}
:deep(.combo-cell[data-state="blocked"]) {
  background: #5a4632;
}
:deep(.combo-cell[data-state="current"]) {
  background: #60a5fa;
  box-shadow: 0 0 0 2px #dbeafe inset;
  z-index: 2;
}
:deep(.combo-cell[data-state="naive"]) {
  background: #ff1f0a;
  box-shadow: 0 0 0 2px #fff inset, 0 0 10px #ff4b35;
  z-index: 3;
}
.matrix-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  margin: 10px 0;
  font-size: 12px;
}
.matrix-legend span {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.matrix-legend i {
  width: 11px;
  height: 11px;
  display: inline-block;
  border-radius: 2px;
  background: #55d17a;
}
.matrix-legend i[data-state="current"] {
  background: #60a5fa;
}
.matrix-legend i[data-state="naive"] {
  background: #ff1f0a;
}
.matrix-legend i[data-state="seal"] {
  background: #c83f2b;
}
.matrix-legend i[data-state="wall"] {
  background: #d69a2d;
}
.matrix-legend i[data-state="length"] {
  background: #2b231b;
  border: 1px solid #4b3d2d;
}
.bands h3 {
  margin: 12px 0 6px;
  color: var(--brass);
  font-size: 13px;
}
.bands ul {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 168px;
  overflow: auto;
  border-top: 1px solid var(--line);
}
.bands li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 2px;
  border-bottom: 1px solid rgba(232, 215, 184, 0.08);
  font-size: 12px;
}
.bands .empty {
  font-size: 13px;
  opacity: 0.7;
}
.bottom-grid {
  display: grid;
  grid-template-columns: 1.35fr 0.8fr 1fr;
  gap: 16px;
  margin-top: 16px;
  align-items: start;
}
.frame-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.schedule-note {
  margin: 0 0 8px;
  font-size: 13px;
  line-height: 1.55;
  color: rgba(232, 215, 184, 0.76);
}
.frame-list li {
  display: grid;
  grid-template-columns: 64px 1fr;
  gap: 4px 10px;
  padding: 9px 6px;
  border-bottom: 1px solid var(--line);
  font-size: 13px;
}
.frame-list li[data-active="true"] {
  background: rgba(96, 165, 250, 0.13);
  border-left: 3px solid #60a5fa;
}
.frame-list .time {
  color: var(--brass);
  font-variant-numeric: tabular-nums;
}
.frame-list .progress {
  font-weight: 700;
}
.frame-list .speed,
.frame-list em {
  grid-column: 2;
  opacity: 0.76;
  font-style: normal;
  font-size: 12px;
}
.cart-card-line ul {
  list-style: none;
  margin: 0 0 12px;
  padding: 0;
}
.cart-card-line li {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 0;
  border-bottom: 1px solid rgba(232, 215, 184, 0.08);
  font-size: 13px;
}
.receipt-panel code {
  color: #ffd39a;
}
.verify {
  color: #9bd6a5;
  font-size: 13px;
}
.rule-checks {
  list-style: none;
  margin: 8px 0 12px;
  padding: 0;
}
.rule-checks li {
  font-size: 13px;
  line-height: 1.7;
  color: #9bd6a5;
}
.rule-checks li[data-pass="false"] {
  color: #ff8b78;
}
.receipt {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid #4f8a5b;
  background: #102015;
}
.receipt[data-match="false"] {
  border-color: #c47b2c;
}
.receipt h3 {
  margin: 0 0 8px;
  color: #bde7c4;
}
.receipt p {
  font-size: 13px;
  line-height: 1.5;
  margin: 5px 0;
  overflow-wrap: anywhere;
}
.ok {
  color: #9bd6a5;
}
.warn {
  color: #ffd39a;
}
@media (max-width: 1180px) {
  .layout,
  .bottom-grid {
    grid-template-columns: 1fr;
  }
  .header-actions {
    justify-content: flex-start;
  }
}
@media (max-width: 720px) {
  .lift-app {
    padding: 12px;
  }
  .lift-header {
    align-items: flex-start;
    flex-direction: column;
  }
  .endpoint-grid,
  .deadline-grid {
    grid-template-columns: 1fr;
  }
}
</style>

<style>
/* StageSvg 内部图元使用全局 SVG 属性选择器；放在非 scoped 块中可稳定命中子组件根 SVG 内元素。 */
.stage-svg .svg-bg {
  fill: #f4ecd9;
}
.stage-svg .track {
  fill: none;
  stroke-width: 0.055;
  stroke-dasharray: 0.18 0.14;
  opacity: 0.9;
}
.stage-svg .track-a {
  stroke: #ea580c;
}
.stage-svg .track-b {
  stroke: #0891b2;
}
.stage-svg .gate-marker {
  fill: rgba(96, 165, 250, 0.12);
  stroke: #2563eb;
  stroke-width: 0.035;
  stroke-dasharray: 0.12 0.09;
}
.stage-svg .gate-marker.active {
  fill: rgba(37, 99, 235, 0.22);
  stroke-width: 0.07;
}
.stage-svg .wall-edge {
  stroke: #64748b;
  stroke-linecap: round;
}
.stage-svg .wall-edge[data-policy="sealed"] {
  stroke: #991b1b;
}
.stage-svg .wall-edge[data-tone="wall"] {
  stroke: #475569;
}
.stage-svg .wall-edge[data-policy="graze-ok"] {
  stroke: #15803d;
}
.stage-svg .wall-edge.grazing {
  stroke: #22c55e;
  filter: drop-shadow(0 0 0.12px #22c55e);
}
.stage-svg .wall-edge.violating {
  stroke: #ef4444;
  animation: edge-flash 0.55s ease-in-out infinite alternate;
}
@keyframes edge-flash {
  from { opacity: 0.55; }
  to { opacity: 1; }
}
.stage-svg .beam {
  stroke: #1f2937;
  stroke-width: 0.16;
  stroke-linecap: round;
}
.stage-svg .beam.bad {
  stroke: #dc2626;
}
.stage-svg .beam.naive {
  stroke-dasharray: 0.22 0.12;
}
.stage-svg .beam-middle {
  stroke: #facc15;
  stroke-width: 0.055;
  stroke-linecap: round;
  pointer-events: none;
}
.stage-svg .mid-dot {
  fill: #facc15;
  stroke: #111827;
  stroke-width: 0.025;
}
.stage-svg .cart {
  stroke: #fff7ed;
  stroke-width: 0.055;
}
.stage-svg .cart-a {
  fill: #f97316;
}
.stage-svg .cart-b {
  fill: #0891b2;
}
.stage-svg .cart-core {
  fill: #fff7ed;
}
.stage-svg .ghost-beam {
  stroke: #2563eb;
  stroke-width: 0.08;
  stroke-dasharray: 0.16 0.1;
  opacity: 0.55;
}
.stage-svg .ghost-cap {
  opacity: 0.55;
}
.stage-svg .ghost-cap.a {
  fill: #f97316;
}
.stage-svg .ghost-cap.b {
  fill: #0891b2;
}
.stage-svg .endpoint-label,
.stage-svg .edge-label,
.stage-svg .gate-label,
.stage-svg .middle-label {
  font-family: ui-sans-serif, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
  text-anchor: middle;
  paint-order: stroke;
  stroke: #f4ecd9;
  stroke-width: 0.06;
  stroke-linejoin: round;
}
.stage-svg .endpoint-label {
  font-size: 0.31px;
  font-weight: 800;
}
.stage-svg .endpoint-label.a {
  fill: #c2410c;
}
.stage-svg .endpoint-label.b {
  fill: #0e7490;
}
.stage-svg .middle-label {
  font-size: 0.24px;
  fill: #854d0e;
}
.stage-svg .edge-label {
  font-size: 0.22px;
  font-weight: 700;
}
.stage-svg .edge-label[data-policy="sealed"] {
  fill: #991b1b;
}
.stage-svg .edge-label[data-policy="graze-ok"] {
  fill: #166534;
}
.stage-svg .gate-label {
  font-size: 0.44px;
  font-weight: 900;
  fill: #1d4ed8;
  opacity: 0.55;
}
.stage-svg .gate-label.active {
  opacity: 1;
}
</style>

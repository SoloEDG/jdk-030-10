<script setup lang="ts">
import { computed } from "vue";
import { pointAtDistance, pathLength, poseAt } from "../lib/geometry";
import type { PoseCheck, SceneCard } from "../lib/types";

const props = defineProps<{
  scene: SceneCard;
  uA: number;
  uB: number;
  check: PoseCheck;
  runKind: "plan" | "naive";
  activeGateId: string;
  ghost?: { uA: number; uB: number } | null;
}>();

const pose = computed(() => poseAt(props.scene.carts.A, props.scene.carts.B, props.uA, props.uB));
const ghostPose = computed(() =>
  props.ghost ? poseAt(props.scene.carts.A, props.scene.carts.B, props.ghost.uA, props.ghost.uB) : null,
);

const WORLD_H = 10;
function projectY(y: number): number {
  return WORLD_H - y;
}

function pathD(cart: SceneCard["carts"]["A"]): string {
  const total = pathLength(cart);
  const count = 180;
  let d = "";
  for (let i = 0; i <= count; i += 1) {
    const p = pointAtDistance(cart, (total * i) / count);
    d += `${i === 0 ? "M" : "L"}${p.x.toFixed(3)},${p.y.toFixed(3)} `;
  }
  return d;
}

const pathA = computed(() => pathD(props.scene.carts.A));
const pathB = computed(() => pathD(props.scene.carts.B));

function edgeState(id: string) {
  return props.check.edges.find((edge) => edge.edgeId === id);
}

const beamBad = computed(() => props.check.collisions.length > 0 || !props.check.lengthOk);
const mid1 = computed(() => ({
  x: pose.value.a.x + (pose.value.b.x - pose.value.a.x) * 0.36,
  y: pose.value.a.y + (pose.value.b.y - pose.value.a.y) * 0.36,
}));
const mid2 = computed(() => ({
  x: pose.value.a.x + (pose.value.b.x - pose.value.a.x) * 0.64,
  y: pose.value.a.y + (pose.value.b.y - pose.value.a.y) * 0.64,
}));
const midpoint = computed(() => ({
  x: (pose.value.a.x + pose.value.b.x) / 2,
  y: (pose.value.a.y + pose.value.b.y) / 2,
}));
</script>

<template>
  <svg class="stage-svg" viewBox="0 0 16 10" role="img" aria-label="双机长梁连续配合示意图">
    <rect x="0" y="0" width="16" height="10" rx="0.18" class="svg-bg" />

    <g transform="translate(0 10) scale(1 -1)">
      <!-- 轨迹 -->
      <path :d="pathA" class="track track-a" />
      <path :d="pathB" class="track track-b" />

      <!-- 窄口高亮 -->
      <circle
        v-for="gate in scene.gates"
        :key="gate.id"
        :cx="gate.at.x"
        :cy="gate.at.y"
        r="0.42"
        class="gate-marker"
        :class="{ active: gate.id === activeGateId }"
      />

      <!-- 墙/封条/擦边 -->
      <g v-for="edge in scene.edges" :key="edge.id">
        <line
          :x1="edge.a.x"
          :y1="edge.a.y"
          :x2="edge.b.x"
          :y2="edge.b.y"
          :stroke-width="edge.halfThickness * 2"
          class="wall-edge"
          :data-policy="edge.policy"
          :data-tone="edge.tone ?? 'wall'"
          :class="{
            violating: edgeState(edge.id)?.violated,
            grazing: edge.policy === 'graze-ok' && Math.abs(edgeState(edge.id)?.clearance ?? 99) < 0.015,
          }"
        />
      </g>

      <!-- 诊断矩阵悬停/选中的幽灵配对 -->
      <g v-if="ghostPose" class="ghost-pair">
        <line
          :x1="ghostPose.a.x"
          :y1="ghostPose.a.y"
          :x2="ghostPose.b.x"
          :y2="ghostPose.b.y"
          class="ghost-beam"
        />
        <circle :cx="ghostPose.a.x" :cy="ghostPose.a.y" r="0.13" class="ghost-cap a" />
        <circle :cx="ghostPose.b.x" :cy="ghostPose.b.y" r="0.13" class="ghost-cap b" />
      </g>

      <!-- 实际同一时刻的梁与两端 -->
      <line
        :x1="pose.a.x"
        :y1="pose.a.y"
        :x2="pose.b.x"
        :y2="pose.b.y"
        class="beam"
        :class="{ bad: beamBad, naive: runKind === 'naive' }"
      />
      <line :x1="mid1.x" :y1="mid1.y" :x2="mid2.x" :y2="mid2.y" class="beam-middle" />
      <circle :cx="midpoint.x" :cy="midpoint.y" r="0.055" class="mid-dot" />

      <circle :cx="pose.a.x" :cy="pose.a.y" r="0.19" class="cart cart-a" />
      <circle :cx="pose.b.x" :cy="pose.b.y" r="0.19" class="cart cart-b" />
      <circle :cx="pose.a.x" :cy="pose.a.y" r="0.07" class="cart-core" />
      <circle :cx="pose.b.x" :cy="pose.b.y" r="0.07" class="cart-core" />
    </g>

    <!-- 非翻转文字层 -->
    <g class="labels">
      <text :x="pose.a.x" :y="projectY(pose.a.y) - 0.28" class="endpoint-label a">
        甲 {{ (uA * 100).toFixed(1) }}%
      </text>
      <text :x="pose.b.x" :y="projectY(pose.b.y) - 0.28" class="endpoint-label b">
        乙 {{ (uB * 100).toFixed(1) }}%
      </text>
      <text :x="midpoint.x" :y="projectY(midpoint.y) + 0.28" class="middle-label">梁中段</text>

      <text
        v-for="edge in scene.edges.filter((e) => e.tone === 'seal' || e.tone === 'guide')"
        :key="`label-${edge.id}`"
        :x="(edge.a.x + edge.b.x) / 2"
        :y="projectY((edge.a.y + edge.b.y) / 2) - 0.18"
        class="edge-label"
        :data-policy="edge.policy"
      >
        {{ edge.policy === "sealed" ? "封条·禁碰" : "靠墙·可擦边" }}
      </text>

      <text
        v-for="gate in scene.gates"
        :key="`gate-label-${gate.id}`"
        :x="gate.at.x"
        :y="projectY(gate.at.y) + 0.72"
        class="gate-label"
        :class="{ active: gate.id === activeGateId }"
      >
        {{ gate.index === 1 ? "①" : "②" }}
      </text>
    </g>
  </svg>
</template>

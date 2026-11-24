<script setup lang="ts">
import { computed } from "vue";
import type { ComboCell, NarrowGate } from "../lib/types";

const props = defineProps<{
  matrix: ComboCell[][];
  gate: NarrowGate;
  currentI: number;
  currentJ: number;
  naiveI?: number;
  naiveJ?: number;
}>();

const emit = defineEmits<{
  select: [cell: ComboCell];
  hover: [cell: ComboCell | null];
}>();

const n = computed(() => props.matrix.length);
const topDownRows = computed(() => [...props.matrix].reverse());

function influence(cell: ComboCell): boolean {
  const gateClearances = cell.raw.edges
    .filter((edge) => props.gate.edgeIds.includes(edge.edgeId))
    .map((edge) => Math.abs(edge.clearance));
  return gateClearances.some((value) => value < 0.85);
}

function stateOf(cell: ComboCell): string {
  if (cell.i === props.currentI && cell.j === props.currentJ) return "current";
  if (props.naiveI === cell.i && props.naiveJ === cell.j) return "naive";
  if (!cell.rigidBin) return "length";
  if (cell.gateSafe) return influence(cell) ? "pass-near" : "pass";
  if (cell.blockedSeal) return "seal";
  if (cell.blockedWall) return "wall";
  return "blocked";
}

function title(cell: ComboCell): string {
  return [
    `甲 ${(cell.uA * 100).toFixed(1)}%`,
    `乙 ${(cell.uB * 100).toFixed(1)}%`,
    `梁长吸附误差 ${(cell.lengthError * 1000).toFixed(1)}mm`,
    cell.rigidBin ? "格内存在刚性配对" : "附近无刚性配对",
    cell.gateSafe ? "窄口判定通过" : "窄口判定不通过",
  ].join(" · ");
}
</script>

<template>
  <div class="matrix-wrap">
    <div class="axis-top">甲端进度 →</div>
    <div class="matrix-body">
      <div class="axis-left">乙端进度 →</div>
      <div
        class="matrix-grid"
        data-testid="combo-matrix"
        :style="{
          gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${n}, minmax(0, 1fr))`,
        }"
      >
        <template v-for="row in topDownRows" :key="row[0]?.j ?? 0">
          <button
            v-for="cell in row"
            :key="`${cell.i}-${cell.j}`"
            type="button"
            class="combo-cell"
            :data-state="stateOf(cell)"
            :data-i="cell.i"
            :data-j="cell.j"
            :data-u-a="cell.uA.toFixed(4)"
            :data-u-b="cell.uB.toFixed(4)"
            :data-testid="`combo-cell-${cell.i}-${cell.j}`"
            :aria-label="title(cell)"
            :title="title(cell)"
            @click="emit('select', cell)"
            @mouseenter="emit('hover', cell)"
            @focus="emit('hover', cell)"
            @mouseleave="emit('hover', null)"
            @blur="emit('hover', null)"
          />
        </template>
      </div>
    </div>
    <div class="axis-bottom">0% … 50% … 100%（列：甲）</div>
  </div>
</template>

<style scoped>
.matrix-wrap {
  width: 100%;
}
.axis-top,
.axis-bottom {
  text-align: center;
  font-size: 12px;
  color: rgba(232, 215, 184, 0.68);
  margin: 2px 0;
}
.axis-bottom {
  margin-top: 6px;
}
.matrix-body {
  display: grid;
  grid-template-columns: 26px minmax(0, 1fr);
  gap: 6px;
  align-items: stretch;
}
.axis-left {
  writing-mode: vertical-rl;
  transform: rotate(180deg);
  text-align: center;
  font-size: 12px;
  color: rgba(232, 215, 184, 0.68);
}
</style>

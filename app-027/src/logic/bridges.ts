import type { Bridge, Pt } from './types'
import { dist, pointAtArcLength, polylineLength } from './geometry'

export type CutRun = { points: Pt[]; closed: boolean }

export type BridgeMetrics = {
  /** 实际生效的连刀点数量 */
  count: number
  /** 规则要求的数量 */
  required: number
  /** 每个缺口被挖掉的弧长（mm） */
  arcs: number[]
  /** 缺口两端点之间的直线距离（mm）——物理缺口宽度 */
  widths: number[]
  /** 实际使用的缺口宽度（mm），被削窄时小于设定值 */
  appliedWidthMm: number
  /** 轮廓几何偏差（mm）：被挖弧段相对弦的最大偏离 */
  geometryDeviationMm: number
  /** 挖缺口后重新计算的周长 / 面积 */
  lengthAfter: number
  areaAfter: number
  lengthBefore: number
  areaBefore: number
  /** 因碎片过小被削窄（降级） */
  degraded: boolean
  /** 规则说明 */
  reason: string
}

export type BridgeRuleOptions = {
  rule: 'by_area' | 'by_length' | 'manual'
  areaThresholdMm2: number
  bridgeWidthMm: number
  bridgeEveryMm: number
}

/** 缺口：s 为沿轮廓的精确弧长起点，widthMm 为挖掉的弧长 */
export type BridgeGap = { s: number; widthMm: number; atIndex: number }

/** 连刀点锚点（供预览与放大视图使用）：at/end 为缺口真正断开的两个端点 */
export type BridgeAnchor = {
  at: Pt
  end: Pt
  widthMm: number
  atIndex: number
  /** 缺口两端附近的局部刀路（放大视图用）：at 前的一段刀路 */
  localBefore: Pt[]
  /** end 后的一段刀路；放大镜中两条折线之间即真正的断开处 */
  localAfter: Pt[]
}

export type BridgePlan = {
  gaps: BridgeGap[]
  /** 供数据模型使用（顶点下标 + 宽度） */
  bridges: Bridge[]
  metrics: BridgeMetrics
}

/** 缺口总弧长最多占周长的比例，超过则削窄单个缺口（保证几何不被破坏） */
const MAX_GAP_RATIO = 0.6

/** 累积弧长（到每个顶点的起点） */
export function arcTable(pts: Pt[]): number[] {
  const acc: number[] = new Array(pts.length)
  acc[0] = 0
  for (let i = 1; i < pts.length; i++) acc[i] = acc[i - 1] + dist(pts[i - 1], pts[i])
  return acc
}

/** 找离给定弧长位置最近的顶点下标 */
function nearestIndex(acc: number[], s: number): number {
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < acc.length; i++) {
    const d = Math.abs(acc[i] - s)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

/**
 * 连刀点规划（不能只是「随机挖一段」）：
 * 1) 计算面积 A 与周长 L
 * 2) A < areaThreshold → 必须连刀（碎片风险），至少 2 个，分布尽可能均匀
 * 3) 否则按 L / bridgeEveryMm 取整得数量 n（n ≥ 0）
 * 4) 在轮廓上按等弧长取 n 个锚点，每个锚点处沿轮廓挖掉 bridgeWidthMm 的段
 *
 * manualAt 为手工放置的顶点下标（规则为 manual 时使用）。
 */
export function planBridges(
  pts: Pt[],
  closed: boolean,
  area: number,
  length: number,
  opts: BridgeRuleOptions,
  manualAt: number[] = [],
): BridgePlan {
  const L = length || polylineLength(pts, closed)
  const A = area
  const required =
    opts.rule === 'manual'
      ? manualAt.length
      : !closed || pts.length < 3 || L <= 0
        ? 0
        : A < opts.areaThresholdMm2
          ? 2
          : Math.floor(L / Math.max(opts.bridgeEveryMm, 0.001))

  const metrics: BridgeMetrics = {
    count: 0,
    required,
    arcs: [],
    widths: [],
    appliedWidthMm: opts.bridgeWidthMm,
    geometryDeviationMm: 0,
    lengthBefore: L,
    areaBefore: A,
    lengthAfter: L,
    areaAfter: A,
    degraded: false,
    reason: '',
  }

  if (required <= 0) {
    metrics.reason =
      opts.rule === 'manual'
        ? '手工放置：未添加连刀点'
        : closed
          ? `周长 ${L.toFixed(2)}mm < 每段 ${opts.bridgeEveryMm}mm，无需连刀`
          : '未闭合轮廓无法连刀'
    return { gaps: [], bridges: [], metrics }
  }

  // 单个缺口宽度上限：保证 n 个缺口总弧长 ≤ 60% 周长，且相邻缺口不重叠
  const appliedWidth = Math.min(opts.bridgeWidthMm, (MAX_GAP_RATIO * L) / required)
  metrics.appliedWidthMm = appliedWidth
  if (appliedWidth < opts.bridgeWidthMm - 1e-9) {
    metrics.degraded = true
    metrics.reason = `轮廓总长 ${L.toFixed(2)}mm 过短，缺口宽度由 ${opts.bridgeWidthMm}mm 削窄至 ${appliedWidth.toFixed(3)}mm（保留 ${required} 个连刀点）`
  }

  const acc = arcTable(pts)
  const rawS: number[] = []
  const rawIdx: number[] = []
  if (opts.rule === 'manual') {
    for (const m of manualAt) {
      const idx = Math.max(0, Math.min(pts.length - 1, Math.round(m)))
      rawS.push(acc[idx])
      rawIdx.push(idx)
    }
    metrics.reason = `手工放置 ${rawS.length} 个连刀点`
  } else if (A < opts.areaThresholdMm2) {
    // 碎片：两个连刀点相隔半个周长（等弧长分布）
    rawS.push(L * 0.25, L * 0.75)
    rawIdx.push(nearestIndex(acc, L * 0.25), nearestIndex(acc, L * 0.75))
    metrics.reason = `碎片面积 ${A.toFixed(2)}mm² < 阈值 ${opts.areaThresholdMm2}mm²，强制 2 个连刀点（均匀分布）`
  } else {
    for (let k = 0; k < required; k++) {
      const s = (L * (k + 0.5)) / required
      rawS.push(s)
      rawIdx.push(nearestIndex(acc, s))
    }
    metrics.reason = `周长 ${L.toFixed(2)}mm ÷ ${opts.bridgeEveryMm}mm → ${required} 个连刀点（等弧长分布）`
  }

  let gaps: BridgeGap[] = rawS.map((s, i) => ({
    s: ((s % L) + L) % L,
    widthMm: Math.round(appliedWidth * 10000) / 10000,
    atIndex: rawIdx[i],
  }))
  gaps.sort((a, b) => a.s - b.s)
  // 缺口不允许跨越轮廓起点（s=0）：跨缝的缺口会被「绕回段」切成两半。
  // 把这样的缺口整体贴着起点放在缝前，绕回段仍按完整一刀断开。
  for (const g of gaps) {
    if (g.s + g.widthMm > L) g.s = Math.max(0, L - g.widthMm)
  }
  // 缺口严格按等弧长位置排布；仅在「缺口所在的同一条边」内做有界微调，
  // 让缺口尽量落在单条直线段内（宽度=弦长）。绝不迁移到别的边——
  // 否则点疏密不均时所有缺口都会被挤到点密的一侧，长边中段一个都没有。
  if (opts.rule !== 'manual') gaps = snapGapWithinOwnEdge(pts, acc, L, gaps)
  // 环形去重：按弧长排序后，既检查相邻也检查首尾（绕回起点处）
  const dedup = dropOverlappingGaps(gaps, L)
  gaps = dedup.gaps
  if (dedup.dropped > 0) {
    metrics.degraded = true
    metrics.reason += `；${dedup.dropped} 个连刀点因与相邻缺口重叠被合并`
  }
  for (const g of gaps) g.atIndex = nearestIndex(acc, g.s)

  const stats = gapStats(pts, L, gaps)
  metrics.count = gaps.length
  metrics.arcs = gaps.map((g) => g.widthMm)
  metrics.widths = stats.widths
  metrics.geometryDeviationMm = stats.deviation
  metrics.lengthAfter = L - gaps.reduce((a, g) => a + g.widthMm, 0)
  metrics.areaAfter = Math.max(0, A - stats.removedArea)

  return {
    gaps,
    bridges: gaps.map((g) => ({ atIndex: g.atIndex, widthMm: g.widthMm })),
    metrics,
  }
}

/**
 * 仅在缺口「当前所在的同一条直线段」内部微调缺口起点，使缺口尽量不跨越折角。
 * 移动范围被严格限制在该边内部（最多半个边长），因此缺口不会迁移、不会聚集；
 * 所在边短到放不下缺口时保持等弧长原位置不动（缺口允许跨过顶点，
 * 开挖时会精确地沿弧长断开，几何完整保留）。
 */
function snapGapWithinOwnEdge(pts: Pt[], acc: number[], L: number, gaps: BridgeGap[]): BridgeGap[] {
  const n = pts.length
  return gaps.map((g) => {
    // 二分找到 s 所在的边 i（acc[i] <= s < acc[i+1]，最后一条边绕回起点）
    let loIdx = 0
    let hiIdx = n - 1
    while (loIdx < hiIdx) {
      const mid = (loIdx + hiIdx + 1) >> 1
      if (acc[mid] <= g.s + 1e-9) loIdx = mid
      else hiIdx = mid - 1
    }
    const i = loIdx
    const eLo = acc[i]
    const eHi = i + 1 < n ? acc[i + 1] : L
    const edgeLen = eHi - eLo
    if (edgeLen < g.widthMm + 1e-9) return g
    // 把缺口夹在边内 [eLo, eHi - w]；s 已在边内，偏移不会超过半个边长
    const s = Math.min(Math.max(g.s, eLo), eHi - g.widthMm)
    return { ...g, s }
  })
}

/**
 * 环形去重：缺口按弧长排序后，删除与「前一个」或「绕回后第一个」缺口重叠的缺口。
 * 线性扫描只检查相邻，处理不了首尾相接的情况——短轮廓、缺口多时，
 * 起点两侧会落下两个互相压住的缺口（等于挖掉双倍宽度）。
 */
function dropOverlappingGaps(gaps: BridgeGap[], L: number): { gaps: BridgeGap[]; dropped: number } {
  const EPS = 1e-6
  let cur = gaps.slice().sort((a, b) => a.s - b.s)
  let dropped = 0
  // 重复扫描直到稳定：删掉某个缺口后其两侧可能变为新的相邻关系
  for (;;) {
    if (cur.length <= 1) break
    let remove = -1
    for (let i = 0; i < cur.length; i++) {
      const g = cur[i]
      const prev = cur[(i - 1 + cur.length) % cur.length]
      // 前一缺口末端（考虑绕回：i=0 时前一缺口在 L 之前）
      const prevEnd = i === 0 ? prev.s + prev.widthMm - L : prev.s + prev.widthMm
      if (g.s < prevEnd - EPS) {
        remove = i
        break
      }
    }
    if (remove < 0) break
    cur.splice(remove, 1)
    dropped += 1
  }
  return { gaps: cur, dropped }
}

function gapStats(
  pts: Pt[],
  L: number,
  gaps: BridgeGap[],
): { widths: number[]; deviation: number; removedArea: number } {
  const widths: number[] = []
  let deviation = 0
  let removedArea = 0
  for (const g of gaps) {
    const a = pointAtArcLength(pts, true, g.s)
    const b = pointAtArcLength(pts, true, (g.s + g.widthMm) % L)
    widths.push(dist(a, b))
    const samples: Pt[] = []
    const steps = 10
    for (let i = 0; i <= steps; i++) samples.push(pointAtArcLength(pts, true, (g.s + (g.widthMm * i) / steps) % L))
    for (const p of samples) deviation = Math.max(deviation, pointToSegment(p, a, b))
    // 缺口面积 = 被挖弧段与弦围成的闭合多边形（必须回到起点，否则鞋带公式会算出到原点的三角形）
    let polyArea = 0
    for (let i = 0; i < samples.length; i++) {
      const p = samples[i]
      const q = samples[(i + 1) % samples.length]
      polyArea += p.x * q.y - q.x * p.y
    }
    removedArea += Math.abs(polyArea / 2)
  }
  return { widths, deviation, removedArea }
}

function pointToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  if (l2 < 1e-12) return dist(p, a)
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t))
}

/**
 * 应用连刀点：把闭合轮廓拆成若干「切割段」，同时返回每个缺口的精确端点锚点。
 * 闭合轮廓有 n 个缺口就有 n 段刀路；第 i 段为「缺口 i 末端 → 缺口 i+1 起点」，
 * 最后一段跨越轮廓起点（绕回段）同样完整断开，不会少一截。
 * 端点按弧长精确插值插入折线，缺口内的几何整段跳过、缺口外的刀路一点不丢。
 */
export function applyBridges(
  pts: Pt[],
  closed: boolean,
  gapsIn: BridgeGap[],
): { runs: CutRun[]; anchors: BridgeAnchor[] } {
  if (!closed || gapsIn.length === 0) return { runs: [{ points: pts, closed }], anchors: [] }
  const n = pts.length
  if (n < 3) return { runs: [{ points: pts, closed }], anchors: [] }
  const L = polylineLength(pts, true)
  if (L <= 0) return { runs: [{ points: pts, closed }], anchors: [] }

  // 缺口不允许跨越轮廓起点（s=0），否则会被绕回段切成两半
  const clamped = gapsIn.map((g) => ({ ...g, s: Math.max(0, Math.min(g.s, L - g.widthMm)) }))
  // 钳到缝前后可能与相邻缺口重叠，再做一次环形去重
  const { gaps: sorted } = dropOverlappingGaps(clamped, L)
  if (sorted.length === 0) return { runs: [{ points: pts, closed: true }], anchors: [] }
  const gapEnds = sorted.map((g) => g.s + g.widthMm)
  const starts = sorted.map((g) => g.s)
  const acc = arcTable(pts)
  const w = sorted[0].widthMm

  // 第 i 段刀路 = 缺口 i 末端 → 缺口 i+1 起点（最后一段跨越轮廓起点）。
  // 先算出每段折线，空段（异常输入下缺口贴在一起）连同对应缺口一起丢弃，
  // 保证「缺口 ↔ 刀路段 ↔ 锚点」始终一一对应不错位。
  const segs = sorted.map((_, i) => {
    const a = gapEnds[i]
    const b = i + 1 < sorted.length ? starts[i + 1] : starts[0] + L
    return collectArcRun(pts, acc, L, a, b)
  })
  const keep = segs.map((points) => points.length >= 2)
  const runs: CutRun[] = []
  const anchors: BridgeAnchor[] = []
  sorted.forEach((g, i) => {
    if (!keep[i]) return
    runs.push({ points: segs[i], closed: false })
    anchors.push({
      // at = 缺口前端（沿弧长 s），end = 缺口末端（s + width）
      at: pointAtArcLength(pts, true, starts[i]),
      end: pointAtArcLength(pts, true, gapEnds[i] % L),
      widthMm: g.widthMm || w,
      atIndex: g.atIndex,
      localBefore: collectArcRun(pts, acc, L, Math.max(0, starts[i] - w * 3), starts[i]),
      localAfter: collectArcRun(pts, acc, L, gapEnds[i], Math.min(L, gapEnds[i] + w * 3)),
    })
  })

  if (runs.length === 0) return { runs: [{ points: pts, closed: true }], anchors: [] }
  return { runs, anchors }
}

/** 取自弧长 [a, b] 的折线；b 可超过 L（跨越轮廓起点）。端点按弧长精确插值。 */
function collectArcRun(pts: Pt[], acc: number[], L: number, a: number, b: number): Pt[] {
  if (b <= L + 1e-9) return collectArcSpan(pts, acc, a, b)
  // 跨越起点：拆成 [a, L] + [0, b-L]，起点处只保留一个点
  const first = collectArcSpan(pts, acc, a, L)
  const second = collectArcSpan(pts, acc, 0, b - L)
  return [...first, ...second.slice(1)]
}

/** 取自弧长 [a, b]（要求 0 ≤ a ≤ b ≤ L）的折线，端点按弧长精确插值。 */
function collectArcSpan(pts: Pt[], acc: number[], a: number, b: number): Pt[] {
  const n = pts.length
  const out: Pt[] = []
  const push = (p: Pt): void => {
    const last = out[out.length - 1]
    if (!last || dist(last, p) > 1e-7) out.push({ x: p.x, y: p.y })
  }
  push(pointAtArcLength(pts, true, a))
  for (let i = 0; i < n; i++) {
    if (acc[i] > a + 1e-9 && acc[i] < b - 1e-9) push(pts[i])
  }
  push(pointAtArcLength(pts, true, b))
  return out
}
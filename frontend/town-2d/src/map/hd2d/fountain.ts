import { hash } from '../pixel/noise'
import { sprite, stone, type Paint } from './sprite'

// 雕塑喷泉的逐帧动画：雕像肩上的水罐往上层小盆里倒水，小盆两侧往下池里落水、前沿往下滴水；
// 落水处翻起水花、溅出水珠、一圈圈涟漪往外推，池面零星闪光。
// FRAMES 帧一个循环：水流的亮纹、水珠、涟漪、闪光的周期都整除 FRAMES，首尾接得上。
// 立牌只有全透明和不透明两种像素，水珠、涟漪都画成整像素。

const W = 58
const H = 46
const FRAMES = 24
const FPS = 12

const WATER = '#4f88a6'
const WATER_SKY = '#5d97b3'
const WATER_DEEP = '#467f9d'
const RIPPLE = '#7db4ca'
const STREAM = '#9cc6d2'
const STREAM_DARK = '#7fb3c9'
const GLINT = '#cfe6ee'
const FOAM = '#eef7fa'
const BOWL_WATER = '#5c93ad'
/** 这些颜色是水：自发光图里只留它们 */
const WATERY = [WATER, WATER_SKY, WATER_DEEP, RIPPLE, STREAM, STREAM_DARK, GLINT, FOAM, BOWL_WATER]

/** 椭圆第 dy 行的半宽；纵向多算半格，上下两头不会只剩孤零零一个像素 */
const halfWidth = (rx: number, ry: number, dy: number) =>
  Math.round(rx * Math.sqrt(Math.max(0, 1 - (dy / (ry + 0.5)) ** 2)))

/** 下池水面（和 ellipse(29, 35, 23, 4) 画出来的一样） */
function inPool(x: number, y: number) {
  const dy = y - 35
  return Math.abs(dy) <= 4 && Math.abs(x - 29) <= halfWidth(23, 4, dy)
}

/** 一股水：沿抛物线落下，s 从 0 到 1 对应落下的时间，x 匀速、y 加速。fall 是落完要几帧 */
interface Stream {
  x0: number
  y0: number
  dx: number
  dy: number
  fall: number
  /** 两像素宽（往哪边加一列） */
  wide: -1 | 0 | 1
}

const STREAMS: Stream[] = [
  // 小盆两侧的外沿：先平着冲出去再往下落
  { x0: 19, y0: 18, dx: -7, dy: 15, fall: 10, wide: 1 },
  { x0: 39, y0: 18, dx: 7, dy: 15, fall: 10, wide: -1 },
]
/** 雕像水罐倒进小盆的细流 */
const POUR: Stream = { x0: 35, y0: 6, dx: 1, dy: 11, fall: 6, wide: 0 }
/** 小盆前沿往下滴水的几处：[x, 盆沿 y, 落到的水面 y] */
const DRIPS: [number, number, number][] = [
  [22, 20, 36],
  [24, 20, 37],
  [34, 20, 37],
  [36, 20, 36],
]
const DRIP_FALL = 6
/** 溅起的水珠几帧落回水面 */
const FRAMES_PER_HOP = 8

/** 抛物线按顺序落在哪些像素上，每个像素带它的时间坐标（帧） */
function path(s: Stream) {
  const out: { x: number; y: number; t: number }[] = []
  for (let i = 0; i <= 200; i++) {
    const k = i / 200
    const x = Math.round(s.x0 + s.dx * k),
      y = Math.round(s.y0 + s.dy * k * k)
    const last = out[out.length - 1]
    if (last && last.x === x && last.y === y) continue
    out.push({ x, y, t: k * s.fall })
  }
  return out
}

/** 一股水的一帧：亮纹顺着水往下走（越往下走得越快，拉得越长），下段断成水滴 */
function drawStream(p: Paint, s: Stream, f: number) {
  const pts = path(s)
  pts.forEach(({ x, y, t }, i) => {
    const phase = (((t - f) % 6) + 6) % 6
    const low = i / pts.length > 0.62
    if (low && phase > 3.4 && phase < 4.4) return
    const c = phase < 1.2 ? FOAM : phase < 2 ? GLINT : STREAM
    p.px(x, y, c)
    if (s.wide) p.px(x + s.wide, y, phase < 1.2 ? GLINT : STREAM_DARK)
  })
  return pts[pts.length - 1]
}

/** 落水处：翻起的白水花，四周溅起的水珠按抛物线飞出又落回去 */
function drawSplash(p: Paint, x: number, y: number, f: number, seed: number) {
  p.px(x, y, FOAM)
  p.px(x - 1, y, GLINT)
  p.px(x + 1, y, GLINT)
  const crown: [number, number][] = [
    [-2, 0],
    [2, 0],
    [-1, -1],
    [1, -1],
    [0, -1],
    [0, -2],
  ]
  crown.forEach(([dx, dy], k) => {
    if (hash(f, k, seed) < 0.45) p.px(x + dx, y + dy, k < 2 ? GLINT : FOAM)
  })
  // 每颗水珠 8 帧一跳，一个循环跳三次，三次的方向和高度各不相同
  for (let k = 0; k < 5; k++) {
    const life = (f + k * 5 + seed) % FRAMES_PER_HOP
    const hop = Math.floor((f + k * 5 + seed) / FRAMES_PER_HOP) % (FRAMES / FRAMES_PER_HOP)
    const vx = (hash(k, hop, seed + 1) * 2 - 1) * 0.8
    const vy = 1 + hash(k, hop, seed + 2) * 0.8
    const dx = Math.round(vx * life),
      dy = Math.round(vy * life - 0.32 * life * life)
    if (dy <= 0 || life === 0) continue
    p.px(x + dx, y - dy, life < 4 ? FOAM : GLINT)
  }
}

/** 涟漪：从落水处往外推的椭圆圈，越大越稀，出了水面不画。reach 是最后推多大 */
function drawRipples(p: Paint, x: number, y: number, f: number, seed: number, reach = 7.5) {
  for (const offset of [0, 6]) {
    const age = (f + offset + seed) % 12
    const rx = 1.5 + (age * (reach - 1.5)) / 11,
      ry = rx * 0.36
    const steps = Math.ceil(rx * 7)
    for (let i = 0; i < steps; i++) {
      if (age > 7 && i % 2) continue
      const a = (i / steps) * Math.PI * 2
      const px = Math.round(x + rx * Math.cos(a)),
        py = Math.round(y + ry * Math.sin(a))
      if (inPool(px, py)) p.px(px, py, age < 6 ? RIPPLE : WATER_SKY)
    }
  }
}

/** 前沿滴水：每处三滴错开落下，越落越快、拉成两格长，落到水面溅一下 */
function drawDrips(p: Paint, f: number) {
  DRIPS.forEach(([x, top, bottom], k) => {
    p.px(x, top, STREAM)
    for (let d = 0; d < 3; d++) {
      const age = (f + d * 2 + k * 3) % DRIP_FALL
      const y = Math.round(top + 1 + (bottom - top - 1) * (age / (DRIP_FALL - 1)) ** 2)
      if (age === DRIP_FALL - 1) {
        p.px(x, bottom, FOAM)
        if (hash(f, k, 31) < 0.5) p.px(x + (k % 2 ? 1 : -1), bottom - 1, GLINT)
        continue
      }
      p.px(x, y, age < 2 ? STREAM : GLINT)
      if (age >= 3) p.px(x, y - 1, STREAM)
    }
  })
}

/** 池面闪光：固定的几个点，各自隔 12 帧亮一回，最亮那帧左右各带一格 */
function drawGlints(p: Paint, f: number) {
  for (let k = 0; k < 9; k++) {
    const x = 8 + Math.floor(hash(k, 1, 77) * 42),
      y = 32 + Math.floor(hash(k, 2, 77) * 7)
    if (!inPool(x, y) || (x >= 25 && x <= 32 && y <= 34)) continue
    const age = (f + Math.floor(hash(k, 3, 77) * 12)) % 12
    if (age > 2) continue
    p.px(x, y, age === 1 ? FOAM : GLINT)
    if (age === 1)
      for (const [dx, dy] of [
        [-1, 0],
        [1, 0],
      ])
        if (inPool(x + dx, y + dy)) p.px(x + dx, y + dy, STREAM)
  }
}

function ellipse(
  p: Paint,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  c: (t: number, y: number) => string
) {
  for (let y = -ry; y <= ry; y++) {
    const half = halfWidth(rx, ry, y)
    for (let x = -half; x <= half; x++) p.px(cx + x, cy + y, c((x + half) / (2 * half + 1), y))
  }
}

function drawFrame(p: Paint, f: number) {
  // 水池：石沿、朝前的池壁
  p.rect(3, 36, 52, 8, '#aca494')
  p.rect(3, 36, 52, 1, '#c8c0b0')
  p.rect(3, 43, 52, 1, '#7c7466')
  for (let x = 3; x < 55; x += 7) p.rect(x, 37, 1, 6, '#948c7e')
  ellipse(p, 29, 35, 26, 6, (t) => stone(t, '#c2baa9'))
  // 水面：靠里一侧映着天，靠外一侧深一点
  ellipse(p, 29, 35, 23, 4, (_, y) => (y <= -3 ? WATER_SKY : y >= 3 ? WATER_DEEP : WATER))
  // 几道水纹跟着落水一起轻轻晃
  const sway = Math.round(Math.sin((f / FRAMES) * Math.PI * 4))
  for (let k = 0; k < 8; k++) {
    const x = 10 + Math.floor(hash(k, 3, 9) * 36) + (k % 2 ? sway : -sway),
      y = 33 + Math.floor(hash(k, 4, 9) * 5)
    if (inPool(x, y) && inPool(x + 1, y)) p.rect(x, y, 2, 1, RIPPLE)
  }
  drawGlints(p, f)
  // 涟漪先画，柱子和水流盖在上面
  const ends = STREAMS.map((s) => {
    const pts = path(s)
    return pts[pts.length - 1]
  })
  ends.forEach((e, k) => drawRipples(p, e.x, e.y, f, k * 5))
  DRIPS.forEach(([x, , bottom], k) => drawRipples(p, x, bottom, f, k * 3 + 1, 4.5))
  // 中间的柱子、上层小盆
  p.rect(26, 18, 6, 17, '#c8c0b0')
  p.rect(26, 18, 2, 17, '#e0d8c8')
  p.rect(30, 18, 2, 17, '#a09888')
  // 柱身被溅湿的一道深色
  p.rect(26, 31, 6, 3, '#aaa293')
  ellipse(p, 29, 18, 10, 2, (t) => stone(t, '#c2baa9'))
  p.rect(21, 18, 17, 1, BOWL_WATER)
  // 小盆的水面：一点亮光来回走
  const glide = 22 + Math.round((Math.sin((f / FRAMES) * Math.PI * 2) * 0.5 + 0.5) * 13)
  p.px(glide, 18, GLINT)
  // 雕像：长袍的人像，右肩扛着水罐往外倒水；光从左上来，左亮右暗
  const MARBLE = '#e4e0d8',
    LIT = '#f2efe8',
    SHADE = '#b8b2a8'
  p.rect(28, 2, 3, 3, MARBLE)
  p.px(28, 2, LIT)
  p.px(30, 4, SHADE)
  p.rect(27, 5, 4, 5, MARBLE)
  p.rect(27, 5, 1, 5, LIT)
  p.rect(26, 10, 6, 7, MARBLE)
  p.rect(26, 10, 1, 7, LIT)
  p.rect(30, 5, 1, 12, SHADE)
  p.rect(31, 10, 1, 7, SHADE)
  for (let y = 11; y < 17; y += 2) p.px(28 + ((y >> 1) % 2), y, '#d0cabe')
  // 抬起的手臂和水罐（罐口朝右下）
  p.rect(31, 6, 1, 2, MARBLE)
  p.rect(31, 3, 3, 3, '#d8d0c2')
  p.px(31, 3, LIT)
  p.rect(33, 4, 1, 2, '#a89e90')
  p.px(34, 5, '#a89e90')
  // 水流和水花
  const pour = drawStream(p, POUR, f)
  if (hash(f, 0, 5) < 0.6) p.px(pour.x - 1, pour.y, FOAM)
  if (hash(f, 1, 5) < 0.6) p.px(pour.x + 1, pour.y, GLINT)
  STREAMS.forEach((s) => drawStream(p, s, f))
  drawDrips(p, f)
  ends.forEach((e, k) => drawSplash(p, e.x, e.y, f, k * 7))
}

/** 水的自发光图：和图集一样大，不是水的像素涂黑。暖色阳光下水也是清亮的蓝，夜里像打了灯 */
function waterOnly(canvas: HTMLCanvasElement) {
  const glow = document.createElement('canvas')
  glow.width = canvas.width
  glow.height = canvas.height
  const ctx = glow.getContext('2d')!
  ctx.drawImage(canvas, 0, 0)
  const img = ctx.getImageData(0, 0, glow.width, glow.height)
  const keep = new Set(WATERY.map((c) => parseInt(c.slice(1), 16)))
  const d = img.data
  for (let i = 0; i < d.length; i += 4)
    if (!keep.has((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])) d[i] = d[i + 1] = d[i + 2] = 0
  ctx.putImageData(img, 0, 0)
  return glow
}

/** 逐帧动画：横排 FRAMES 帧的图集；每帧画在自己的格子里，出格的像素丢掉，不会画进隔壁帧 */
export function fountain() {
  const canvas = sprite(W * FRAMES, H, (p) => {
    for (let f = 0; f < FRAMES; f++) {
      const ox = f * W
      const inside = (x: number, y: number) => x >= 0 && x < W && y >= 0 && y < H
      drawFrame(
        {
          px: (x, y, c) => {
            if (inside(Math.round(x), Math.round(y))) p.px(x + ox, y, c)
          },
          rect: (x, y, w, h, c) => p.rect(x + ox, y, w, h, c),
          line: (x0, y0, x1, y1, c) => p.line(x0 + ox, y0, x1 + ox, y1, c),
        },
        f
      )
    }
  })
  return { canvas, glow: waterOnly(canvas), frames: FRAMES, fps: FPS }
}

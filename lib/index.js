// dsh-color-contrast — WCAG 对比度计算器（功能型）。纯 Node，无网络。
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "颜色对比度";
const inject = ["tools"];

function parseHex(input) {
  if (typeof input !== "string") throw new Error("颜色必须是 #RRGGBB 或 RRGGBB 格式的字符串");
  let s = input.trim().replace(/^#/, "");
  if (s.length === 3) s = s.split("").map((c) => c + c).join("");
  if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new Error(`非法颜色：${input}（应为 #RRGGBB 或 RRGGBB）`);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255);
}

function luminance(rgb) {
  const lin = rgb.map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function ratio(fg, bg) {
  const l1 = luminance(parseHex(fg));
  const l2 = luminance(parseHex(bg));
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

function assess(r) {
  return {
    ratio: Math.round(r * 100) / 100,
    aa_normal: r >= 4.5,
    aa_large: r >= 3.0,
    aaa_normal: r >= 7.0,
    aaa_large: r >= 4.5,
  };
}

function toHex([r, g, b]) {
  const h = (n) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}

// 把 RGB 转 HSL，便于在保持色相/饱和度下搜索亮度。
function rgbToHsl(rgb) {
  const [r, g, b] = rgb;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb({ h, s, l }) {
  if (s === 0) return [l, l, l];
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, h + 1 / 3), hue2rgb(p, q, h), hue2rgb(p, q, h - 1 / 3)];
}

function accessibleColorForBg(bgHex, baseHex, targetRatio) {
  // 若原色已达标，直接返回。
  if (ratio(baseHex, bgHex) >= targetRatio) return baseHex;
  const { h, s } = rgbToHsl(parseHex(baseHex));
  const baseL = rgbToHsl(parseHex(baseHex)).l;
  // 判断方向：对背景加深或提亮能获得更高对比度。
  const darken = ratio("#000000", bgHex) >= ratio("#ffffff", bgHex);
  let lo, hi;
  if (darken) {
    // 对比度随亮度降低而升高，可达标区间为 [0, threshold]；取最接近原色的最大亮度。
    lo = 0;
    hi = baseL;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (ratio(toHex(hslToRgb({ h, s, l: mid })), bgHex) >= targetRatio) lo = mid;
      else hi = mid;
    }
    return toHex(hslToRgb({ h, s, l: lo }));
  }
  // 提亮方向：可达标区间为 [threshold, 1]；取最接近原色的最小亮度。
  lo = baseL;
  hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (ratio(toHex(hslToRgb({ h, s, l: mid })), bgHex) >= targetRatio) hi = mid;
    else lo = mid;
  }
  const result = toHex(hslToRgb({ h, s, l: hi }));
  if (ratio(result, bgHex) < targetRatio) throw new Error(`背景 ${bgHex} 下无法仅靠调整亮度达到 ${targetRatio}:1`);
  return result;
}

async function apply(ctx, _config) {
  ctx.tools.register(defineTool({
    name: "contrast_ratio",
    description: "计算两个颜色之间的 WCAG 对比度，并给出 AA/AAA（普通/大字文本）是否达标。颜色用 #RRGGBB 格式。",
    parameters: {
      foreground: { type: "string", required: true, description: "前景色（文字颜色），如 #333333。" },
      background: { type: "string", required: true, description: "背景色，如 #FFFFFF。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          ratio: { type: "number", required: true },
          aa_normal: { type: "boolean", required: true },
          aa_large: { type: "boolean", required: true },
          aaa_normal: { type: "boolean", required: true },
          aaa_large: { type: "boolean", required: true },
        },
      },
      render: (_a, v) => [{
        type: "text",
        text: `对比度 ${v.ratio}:1\n- AA 普通文本：${v.aa_normal ? "✓ 达标" : "✗ 未达标（需 ≥4.5）"}\n- AA 大字文本：${v.aa_large ? "✓ 达标" : "✗ 未达标（需 ≥3.0）"}\n- AAA 普通文本：${v.aaa_normal ? "✓ 达标" : "✗ 未达标（需 ≥7.0）"}\n- AAA 大字文本：${v.aaa_large ? "✓ 达标" : "✗ 未达标（需 ≥4.5）"}`,
      }],
    },
    execute: async (args) => assess(ratio(args.foreground, args.background)),
  }));

  ctx.tools.register(defineTool({
    name: "text_color_for_bg",
    description: "给定背景色，返回该背景上更清晰的黑/白文字颜色及各自的对比度。用于「深底白字还是浅底黑字」的快速判断。",
    parameters: { background: { type: "string", required: true, description: "背景色，如 #1E90FF。" } },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          recommended: { type: "string", required: true },
          black_ratio: { type: "number", required: true },
          white_ratio: { type: "number", required: true },
          recommendation: { type: "string", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: `推荐文字色：${v.recommended}（黑字对比度 ${v.black_ratio}:1，白字 ${v.white_ratio}:1）\n${v.recommendation}` }],
    },
    execute: async (args) => {
      const br = ratio("#000000", args.background);
      const wr = ratio("#ffffff", args.background);
      const blackWins = br >= wr;
      return {
        recommended: blackWins ? "#000000" : "#FFFFFF",
        black_ratio: Math.round(br * 100) / 100,
        white_ratio: Math.round(wr * 100) / 100,
        recommendation: blackWins ? "黑字对比更高，建议用黑字。" : "白字对比更高，建议用白字。",
      };
    },
  }));

  ctx.tools.register(defineTool({
    name: "find_accessible_color",
    description: "给定背景色和一个期望的文字色，自动调整其亮度（保持色相与饱和度）以满足目标对比度（默认 4.5，即 AA）。返回可达标的颜色。",
    parameters: {
      background: { type: "string", required: true, description: "背景色，如 #FFFFFF。" },
      base_color: { type: "string", required: true, description: "期望的前景色，如 #808080。" },
      target_ratio: { type: "number", description: "可选：目标对比度，默认 4.5。" },
    },
    output: {
      schema: {
        type: "object", additionalProperties: false,
        properties: {
          background: { type: "string", required: true },
          original: { type: "string", required: true },
          suggested: { type: "string", required: true },
          ratio: { type: "number", required: true },
          target_ratio: { type: "number", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: `背景 ${v.background} 上，将 ${v.original} 调整为 ${v.suggested}，对比度 ${v.ratio}:1（目标 ${v.target_ratio}:1）。` }],
    },
    execute: async (args) => {
      const target = typeof args.target_ratio === "number" && args.target_ratio > 1 ? args.target_ratio : 4.5;
      const suggested = accessibleColorForBg(args.background, args.base_color, target);
      const r = ratio(suggested, args.background);
      return {
        background: args.background,
        original: args.base_color,
        suggested,
        ratio: Math.round(r * 100) / 100,
        target_ratio: target,
      };
    },
  }));
}

export { apply, inject, name };

"use client";

import { useMemo, useRef, useState } from "react";
// deep import: the shared index pulls in node-only modules (crypto, plaid)
import { fmtMoney, type SankeyModel } from "@finance/shared/src/reports";
import { hueColor, SURFACE, TEXT_MUTED } from "@/lib/chart-theme";

const NODE_W = 13;
const GAP = 9; // vertical breathing room between stacked nodes
const PAD_TOP = 14;
const PAD_BOTTOM = 14;
const MARGIN_LEFT = 128;
const MARGIN_RIGHT = 150;
const COLUMNS = 4;

interface Placed {
  id: string;
  name: string;
  value: number;
  column: number;
  hue: number;
  x: number;
  y: number;
  h: number;
}

interface Ribbon {
  key: string;
  d: string;
  color: string;
  source: string;
  target: string;
  value: number;
  mid: { x: number; y: number };
}

interface Tip {
  x: number;
  y: number;
  title: string;
  value: number;
  sub?: string;
}

function ribbonPath(sx: number, sy: number, tx: number, ty: number, hs: number, ht: number) {
  const cx = sx + (tx - sx) / 2;
  return [
    `M${sx},${sy}`,
    `C${cx},${sy} ${cx},${ty} ${tx},${ty}`,
    `L${tx},${ty + ht}`,
    `C${cx},${ty + ht} ${cx},${sy + hs} ${sx},${sy + hs}`,
    "Z",
  ].join(" ");
}

export function CashFlowSankey({
  model,
  width = 1000,
}: {
  model: SankeyModel;
  width?: number;
}) {
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const { placed, ribbons, height } = useMemo(() => {
    const byColumn: Placed[][] = [[], [], [], []];
    for (const n of model.nodes) {
      byColumn[n.column].push({ ...n, x: 0, y: 0, h: 0 });
    }

    const tallest = Math.max(...byColumn.map((c) => c.length), 1);
    const height = Math.max(360, tallest * 30 + PAD_TOP + PAD_BOTTOM);
    const plot = height - PAD_TOP - PAD_BOTTOM;

    // One scale for the whole diagram — per-column scales would make equal
    // dollars different heights, which is the fastest way to lie with a Sankey.
    let scale = Infinity;
    for (const col of byColumn) {
      if (!col.length) continue;
      const sum = col.reduce((s, n) => s + n.value, 0);
      const usable = plot - GAP * (col.length - 1);
      if (sum > 0 && usable > 0) scale = Math.min(scale, usable / sum);
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1;

    const colX = (c: number) =>
      MARGIN_LEFT + (c * (width - MARGIN_LEFT - MARGIN_RIGHT - NODE_W)) / (COLUMNS - 1);

    for (let c = 0; c < byColumn.length; c++) {
      const col = byColumn[c];
      if (!col.length) continue;
      const totalH = col.reduce((s, n) => s + Math.max(n.value * scale, 2), 0) + GAP * (col.length - 1);
      let y = PAD_TOP + Math.max(0, (plot - totalH) / 2);
      for (const n of col) {
        n.h = Math.max(n.value * scale, 2);
        n.x = colX(c);
        n.y = y;
        y += n.h + GAP;
      }
    }

    const placed = byColumn.flat();
    const index = new Map(placed.map((n) => [n.id, n]));

    // Route links in target order so ribbons out of a node don't cross each
    // other on the way to a column that is already sorted.
    const outCursor = new Map<string, number>();
    const inCursor = new Map<string, number>();
    const ordered = [...model.links].sort((a, b) => {
      const sa = index.get(a.source), sb = index.get(b.source);
      if (sa && sb && sa.y !== sb.y) return sa.y - sb.y;
      const ta = index.get(a.target), tb = index.get(b.target);
      return (ta?.y ?? 0) - (tb?.y ?? 0);
    });

    const ribbons: Ribbon[] = [];
    for (const link of ordered) {
      const s = index.get(link.source);
      const t = index.get(link.target);
      if (!s || !t) continue;
      const hs = s.value > 0 ? (link.value / s.value) * s.h : s.h;
      const ht = t.value > 0 ? (link.value / t.value) * t.h : t.h;
      const so = outCursor.get(s.id) ?? 0;
      const to = inCursor.get(t.id) ?? 0;
      outCursor.set(s.id, so + hs);
      inCursor.set(t.id, to + ht);
      const sx = s.x + NODE_W;
      const tx = t.x;
      ribbons.push({
        key: `${link.source}->${link.target}`,
        d: ribbonPath(sx, s.y + so, tx, t.y + to, hs, ht),
        color: hueColor(link.hue, model.net >= 0),
        source: link.source,
        target: link.target,
        value: link.value,
        mid: { x: (sx + tx) / 2, y: (s.y + so + hs / 2 + t.y + to + ht / 2) / 2 },
      });
    }

    return { placed, ribbons, height };
  }, [model, width]);

  const dimmed = (r: Ribbon) => {
    if (hoverLink) return hoverLink !== r.key;
    if (hoverNode) return r.source !== hoverNode && r.target !== hoverNode;
    return false;
  };

  const showTip = (e: React.MouseEvent, t: Omit<Tip, "x" | "y">) => {
    const box = wrapRef.current?.getBoundingClientRect();
    if (!box) return;
    setTip({ ...t, x: e.clientX - box.left, y: e.clientY - box.top });
  };

  const nameOf = (id: string) => placed.find((n) => n.id === id)?.name ?? id;
  const total = model.income || 1;

  return (
    <div ref={wrapRef} className="relative w-full overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Cash flow: ${fmtMoney(model.income)} in, ${fmtMoney(model.expense)} out`}
        onMouseLeave={() => {
          setTip(null);
          setHoverNode(null);
          setHoverLink(null);
        }}
      >
        <g>
          {ribbons.map((r) => (
            <path
              key={r.key}
              d={r.d}
              fill={r.color}
              opacity={dimmed(r) ? 0.08 : hoverLink === r.key ? 0.62 : 0.34}
              className="transition-opacity duration-150"
              onMouseEnter={(e) => {
                setHoverLink(r.key);
                showTip(e, {
                  title: `${nameOf(r.source)} → ${nameOf(r.target)}`,
                  value: r.value,
                  sub: `${((r.value / total) * 100).toFixed(1)}% of cash in`,
                });
              }}
              onMouseMove={(e) =>
                showTip(e, {
                  title: `${nameOf(r.source)} → ${nameOf(r.target)}`,
                  value: r.value,
                  sub: `${((r.value / total) * 100).toFixed(1)}% of cash in`,
                })
              }
              onMouseLeave={() => {
                setHoverLink(null);
                setTip(null);
              }}
            />
          ))}
        </g>

        <g>
          {placed.map((n) => {
            const color = hueColor(n.hue, model.net >= 0);
            const leftLabel = n.column === 0;
            const tx = leftLabel ? n.x - 8 : n.x + NODE_W + 8;
            const showValue = n.h >= 15;
            return (
              <g key={n.id}>
                <rect
                  x={n.x}
                  y={n.y}
                  width={NODE_W}
                  height={n.h}
                  rx={3}
                  fill={color}
                  opacity={hoverNode && hoverNode !== n.id ? 0.35 : 0.95}
                  stroke={SURFACE}
                  strokeWidth={1}
                  className="cursor-default transition-opacity duration-150"
                  onMouseEnter={(e) => {
                    setHoverNode(n.id);
                    showTip(e, {
                      title: n.name,
                      value: n.value,
                      sub: `${((n.value / total) * 100).toFixed(1)}% of cash in`,
                    });
                  }}
                  onMouseMove={(e) =>
                    showTip(e, {
                      title: n.name,
                      value: n.value,
                      sub: `${((n.value / total) * 100).toFixed(1)}% of cash in`,
                    })
                  }
                  onMouseLeave={() => {
                    setHoverNode(null);
                    setTip(null);
                  }}
                />
                <text
                  x={tx}
                  y={n.y + n.h / 2}
                  textAnchor={leftLabel ? "end" : "start"}
                  dominantBaseline="middle"
                  fontSize={11}
                  fill="currentColor"
                  className="pointer-events-none fill-foreground"
                  paintOrder="stroke"
                  stroke={SURFACE}
                  strokeWidth={3}
                  strokeLinejoin="round"
                >
                  {n.name}
                  {showValue && (
                    <tspan fill={TEXT_MUTED} stroke="none" dx={6} fontSize={10}>
                      {fmtMoney(n.value)}
                    </tspan>
                  )}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {tip && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-card px-2 py-1 text-xs shadow-lg"
          style={{
            left: Math.min(tip.x + 12, width - 200),
            top: Math.max(tip.y - 34, 0),
          }}
        >
          <div className="text-foreground">{tip.title}</div>
          <div className="font-mono text-primary">{fmtMoney(tip.value, { cents: true })}</div>
          {tip.sub && <div className="text-muted-foreground">{tip.sub}</div>}
        </div>
      )}
    </div>
  );
}

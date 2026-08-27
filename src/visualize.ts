/**
 * Renders dependency_graph.json into a self-contained, offline `visualization.html`.
 *
 * The generated HTML embeds the graph data directly and uses a tiny vanilla-JS
 * force-directed layout on an HTML <canvas>, with edges labeled by the field they
 * supply (producer -> consumer). No external libraries or network access required.
 */

import { writeFileSync } from "fs";

interface Node {
  id: string;
  service?: string;
}
interface Edge {
  from: string;
  to: string;
  label?: string;
}

export function renderVisualization(nodes: Node[], edges: Edge[], outPath: string): void {
  const data = JSON.stringify({ nodes, edges });
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Tool Dependency Graph</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; background: #0f172a; color: #e2e8f0; }
  header { padding: 14px 18px; display: flex; align-items: baseline; gap: 14px; border-bottom: 1px solid #1e293b; background:#111c33; flex-wrap:wrap; }
  header h1 { font-size: 16px; margin: 0; color:#f8fafc; }
  header .stat { font-size: 12px; color: #94a3b8; }
  header .controls { margin-left:auto; display:flex; gap:10px; align-items:center; }
  label { font-size: 12px; color:#cbd5e1; }
  input#q { background:#0b1220; color:#e2e8f0; border:1px solid #334155; border-radius:6px; padding:6px 10px; font-size:12px; width:220px; }
  button { background:#2563eb; color:#fff; border:0; border-radius:6px; padding:6px 12px; font-size:12px; cursor:pointer; }
  button.secondary { background:#334155; }
  #wrap { position:relative; }
  canvas { display:block; width:100vw; height:calc(100vh - 52px); }
  #detail { position:fixed; right:18px; bottom:18px; background:#111c33; border:1px solid #334155; border-radius:8px; padding:12px 14px; max-width:340px; font-size:12px; box-shadow:0 8px 30px rgba(0,0,0,.4); display:none; max-height:80vh; overflow:auto; }
  #detail h3 { margin:0 0 6px; font-size:13px; color:#38bdf8; }
  #detail ul { margin:4px 0 0; padding-left:16px; }
  #legend { position:fixed; left:14px; bottom:14px; font-size:11px; color:#94a3b8; background:#111c33; border:1px solid #1e293b; padding:8px 10px; border-radius:8px; }
  .node { cursor:pointer; }
  .badge { font-size:10px; color:#7dd3fc; }
</style>
</head>
<body>
<header>
  <h1>Tool Dependency Graph</h1>
  <span class="stat" id="stat"></span>
  <span class="controls">
    <label>Filter <input id="q" placeholder="node id, e.g. GITHUB_*" /></label>
    <button id="zoomi">+</button>
    <button id="zoomout">-</button>
    <button id="reset" class="secondary">Reset view</button>
  </span>
</header>
<div id="wrap">
  <canvas id="c"></canvas>
  <div id="legend">Drag to pan · wheel to zoom · click a node for its dependencies</div>
  <div id="detail"></div>
</div>
<script>
const GRAPH = ${data};
const nodes = GRAPH.nodes;
const edges = GRAPH.edges;

// scale-free-ish initial placement: ring layout
const N = nodes.length;
nodes.forEach((n, i) => {
  const angle = 2 * Math.PI * i / N;
  const radius = 900 + Math.pow(i % 97, 1.6) * 6;
  n.x = Math.cos(angle) * radius;
  n.y = Math.sin(angle) * radius;
  n.vx = 0; n.vy = 0;
});
const nodeById = new Map(nodes.map(n => [n.id, n]));

// adjacency for detail pane
const inEdges = new Map(); // node -> {from:label}[]
const outEdges = new Map();
for (const e of edges) {
  if (!outEdges.has(e.from)) outEdges.set(e.from, []);
  outEdges.get(e.from).push(e);
  if (!inEdges.has(e.to)) inEdges.set(e.to, []);
  inEdges.get(e.to).push(e);
}

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');
const wrap = document.getElementById('wrap');
let scale = 0.18, tx = 0, ty = 0, dragging = false, lastX, lastY, hover = null;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
}
window.addEventListener('resize', resize);
resize();

// precompute degree for sizing
const degree = new Map(nodes.map(n => [n.id, 0]));
for (const e of edges) { degree.set(e.from, (degree.get(e.from)||0)+1); degree.set(e.to, (degree.get(e.to)||0)+1); }

function worldToScreen(p) { return { x: p.x * scale + tx, y: p.y * scale + ty }; }
function screenToWorld(sx, sy) { return { x: (sx - tx)/scale, y: (sy - ty)/scale }; }

function tick() {
  // repulsion
  const rep = 18000;
  for (let i = 0; i < N; i += 4) {
    const a = nodes[i];
    for (let j = i + 1; j < N; j += 4) {
      const b = nodes[j];
      const dx = a.x - b.x, dy = a.y - b.y;
      const d2 = dx*dx + dy*dy + 1;
      const f = rep / d2;
      const d = Math.sqrt(d2);
      a.vx += dx/d * f; a.vy += dy/d * f;
      b.vx -= dx/d * f; b.vy -= dy/d * f;
    }
  }
  // springs
  for (const e of edges) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const d = Math.sqrt(dx*dx + dy*dy + 1);
    const f = (d - 420) * 0.02;
    a.vx += dx/d * f; a.vy += dy/d * f;
    b.vx -= dx/d * f; b.vy -= dy/d * f;
  }
  // integrate
  for (const n of nodes) {
    n.vx *= 0.82; n.vy *= 0.82;
    n.x += n.vx; n.y += n.vy;
  }
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(1,0,0,1,0,0);
  ctx.translate(tx, ty);
  ctx.scale(scale, scale);
  const q = document.getElementById('q').value.trim().toUpperCase();

  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.lineWidth = 1.2 / scale;
  ctx.beginPath();
  for (const e of edges) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    if (!a || !b) continue;
    if (q && !(a.id.includes(q) || b.id.includes(q))) continue;
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  const qSet = q ? new Set() : null;
  if (q) {
    for (const e of edges) {
      const a = nodeById.get(e.from), b = nodeById.get(e.to);
      if (a && (a.id.includes(q) || (nodeById.get(e.from) && e.from.includes(q)))) qSet.add(e.from);
      if (b && (b.id.includes(q) || (nodeById.get(e.to) && e.to.includes(q)))) qSet.add(e.to);
    }
  }

  for (const n of nodes) {
    let show = true;
    if (q) show = qSet.has(n.id);
    if (!show) continue;
    const d = degree.get(n.id) || 0;
    const r = 4 + Math.min(10, Math.sqrt(d) * 1.1);
    ctx.beginPath();
    ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fillStyle = d > 12 ? '#f43f5e' : d > 5 ? '#f59e0b' : '#22d3ee';
    ctx.fill();
  }
}

let frame = 0;
function loop() {
  if (frame % 1 === 0) { tick(); }
  draw();
  frame++;
  requestAnimationFrame(loop);
}
loop();

// interaction
canvas.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
window.addEventListener('pointermove', e => {
  if (dragging) { const dx = e.clientX-lastX, dy = e.clientY-lastY; tx += dx; ty += dy; lastX = e.clientX; lastY = e.clientY; }
});
window.addEventListener('pointerup', () => dragging = false);
canvas.addEventListener('wheel', e => { e.preventDefault(); const f = e.deltaY < 0 ? 1.1 : 0.9; scale *= f; }, { passive:false });
canvas.addEventListener('dblclick', e => {
  const sx = e.clientX - canvas.getBoundingClientRect().left;
  const sy = e.clientY - canvas.getBoundingClientRect().top;
  // find nearest node within radius
  let best=null, bestD=25/scale;
  const w=screenToWorld(sx, sy);
  for (const n of nodes) {
    const d=Math.hypot(n.x-w.x, n.y-w.y);
    if (d<bestD){best=n;bestD=d;}
  }
  if (best) showDetail(best.id);
});
document.getElementById('zoomi').onclick=()=>scale*=1.4;
document.getElementById('zoomout').onclick=()=>scale*=0.7;
document.getElementById('reset').onclick=()=>{scale=0.18;tx=0;ty=0;};
document.getElementById('q').addEventListener('input', ()=>{});
setTimeout(()=>{ let it=0; const int=setInterval(()=>{ if(it++>60) clearInterval(int); },0); },0);

function showDetail(id) {
  const n = nodeById.get(id);
  if (!n) return;
  const ins = (inEdges.get(id)||[]).slice(0, 60).map(e=>\`<li>\${e.from} <span class="badge">supplies \${e.label||e.from}</span></li>\`);
  const outs = (outEdges.get(id)||[]).slice(0, 60).map(e=>\`<li>\${e.to} <span class="badge">needs \${e.label||''}</span></li>\`);
  const el = document.getElementById('detail');
  el.style.display='block';
  el.innerHTML = \`<h3>\${id}</h3>
    <div>out-edges: \${(outEdges.get(id)||[]).length} · in-edges: \${(inEdges.get(id)||[]).length}</div>
    <b>Supplies (as producer):</b><ul>\${outs.length?outs.join(''):'<li>none</li>'}</ul>
    <b>Consumes (as consumer):</b><ul>\${ins.length?ins.join(''):'<li>none</li>'}</ul>\`;
}
// report counters
document.getElementById('stat').textContent = nodes.length + ' nodes · ' + edges.length + ' edges';
</script>
</body>
</html>
`;
  writeFileSync(outPath, html, "utf-8");
}

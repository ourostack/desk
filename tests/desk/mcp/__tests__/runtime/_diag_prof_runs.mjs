import fs from "node:fs"
for (const f of process.argv.slice(2)) {
  const p = JSON.parse(fs.readFileSync(f, "utf8"))
  const byId = new Map(p.nodes.map((n) => [n.id, n]))
  const parent = new Map(); for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const stack = (id) => { const out = []; for (let x = id; x !== undefined; x = parent.get(x)) { const cf = byId.get(x).callFrame; out.push(`${cf.functionName || "(anon)"}@${cf.url.split("/").slice(-2).join("/")}:${cf.lineNumber + 1}`) } return out }
  // Stretches where the main thread was not idle: consecutive non-idle samples, attributed to the deepest common frames.
  const stretches = []
  let cur = null
  for (let i = 0; i < p.samples.length; i++) {
    const s = p.samples[i], d = (p.timeDeltas[i + 1] ?? 0) / 1000
    const leaf = byId.get(s).callFrame.functionName
    if (leaf === "(idle)") { if (cur) stretches.push(cur); cur = null; continue }
    if (!cur) cur = { ms: 0, counts: new Map() }
    cur.ms += d
    cur.counts.set(s, (cur.counts.get(s) ?? 0) + d)
  }
  if (cur) stretches.push(cur)
  stretches.sort((a, b) => b.ms - a.ms)
  const total = (p.endTime - p.startTime) / 1000
  console.log(f.split(/[\\/]/).pop(), "total", Math.round(total))
  for (const s of stretches.slice(0, 4).filter((s) => s.ms > 40)) {
    const top = [...s.counts].sort((a, b) => b[1] - a[1]).slice(0, 2)
    console.log(`  busy ${Math.round(s.ms)} ms`)
    for (const [id, ms] of top) console.log(`    ${Math.round(ms)} ms in: ${stack(id).slice(0, 14).join(" < ")}`)
  }
}

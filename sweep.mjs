const url = process.argv[2]
const widths = process.argv.slice(3).map(Number)
const t = await (await fetch('http://127.0.0.1:9222/json/new?' + encodeURIComponent(url), {method:'PUT'})).json()
const ws = new WebSocket(t.webSocketDebuggerUrl)
let id = 0; const pend = new Map()
const send = (m, p={}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id:i, method:m, params:p})) })
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } }
await new Promise(r => ws.onopen = r)
await send('Page.enable'); await send('Page.navigate', {url}); await new Promise(r => setTimeout(r, 3000))
console.log('w'.padStart(5), 'brandTop', 'chipsTop', 'navTop', 'sameRow', 'chipsRight/vw', 'hScroll')
for (const w of widths) {
  await send('Emulation.setDeviceMetricsOverride', {width:w, height:760, deviceScaleFactor:1, mobile:true})
  await new Promise(r => setTimeout(r, 350))
  const { result } = await send('Runtime.evaluate', {returnByValue:true, expression:`(() => {
    const T = s => { const e=document.querySelector(s); if(!e) return null; const r=e.getBoundingClientRect(); return {t:Math.round(r.top), b:Math.round(r.bottom), l:Math.round(r.left), r:Math.round(r.right)} }
    const b=T('.brand'), c=T('.bar-end'), n=T('#nav')
    return {b,c,n, same: b&&c ? Math.abs(b.t-c.t)<12 : null, vw: innerWidth, hs: document.documentElement.scrollWidth>innerWidth}
  })()`})
  const v = result.value
  console.log(String(v.vw).padStart(5), String(v.b?.t).padStart(8), String(v.c?.t).padStart(8), String(v.n?.t ?? '-').padStart(6), String(v.same).padStart(7), `${v.c?.r}/${v.vw}`.padStart(13), String(v.hs).padStart(7))
}
await send('Target.closeTarget', {targetId: t.id}); ws.close(); process.exit(0)

// Compares the computed style of every SVG element: original page vs the pack's stand-alone SVG.
// Run: NODE_PATH=<global node_modules> node tools/ingest/audit/geometry_styles.js "$PWD/Geometry_Olympiad_Achiever_Lab_2_Q101-200.html" ingest-out/geometry/<id>/pack.json
const { chromium } = require('playwright'); const fs = require('fs');
const PROPS = ['fill','stroke','stroke-width','stroke-dasharray','stroke-linejoin','fill-opacity','font-size','font-weight','font-style','paint-order','font-family','text-anchor'];
const grab = (root) => { const out=[]; const walk=(e)=>{ for (const c of e.children){ if(c.tagName==='style'||c.tagName==='title') continue; const cs=getComputedStyle(c); const isT=c.tagName==='text'||c.tagName==='tspan'; out.push([c.tagName, ...['fill','stroke','stroke-width','stroke-dasharray','stroke-linejoin','fill-opacity','paint-order'].map(p=>cs.getPropertyValue(p)), ...(isT?['font-size','font-weight','font-style','font-family','text-anchor'].map(p=>cs.getPropertyValue(p)):[])]); walk(c);} }; walk(root); return out; };
(async () => {
  const [,, htmlPath, packPath] = process.argv; const pack = JSON.parse(fs.readFileSync(packPath,'utf8'));
  const b = await chromium.launch(); const ctx = await b.newContext(); const page = await ctx.newPage(); await page.goto('file://'+htmlPath);
  const p2 = await ctx.newPage(); let bad=0, total=0, elems=0;
  for (const q of pack.questions) {
    const a = await page.evaluate(`(${grab.toString()})(document.querySelector('#q${q.number} svg.geo'))`);
    const svg = pack.assets[`q${q.number}-fig`].data;
    await p2.goto('about:blank');
    await p2.goto('data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64'));
    const c = await p2.evaluate(`(${grab.toString()})(document.documentElement)`);
    total++; elems+=a.length;
    if (JSON.stringify(a)!==JSON.stringify(c)) { bad++; if (bad<=5){ for (let i=0;i<Math.max(a.length,c.length);i++) if (JSON.stringify(a[i])!==JSON.stringify(c[i])) { console.log('Q'+q.number,'elem',i,'\n page:',JSON.stringify(a[i]),'\n pack:',JSON.stringify(c[i])); break; } } }
  }
  console.log(`diagrams compared: ${total}, elements compared: ${elems}, diagrams with any style difference: ${bad}`); await b.close();
})();

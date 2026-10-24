/**
 * The seestar driver's web UI: a REST API under /api/seestar and one self-contained page at /.
 * The Dwarf UI (public/) speaks the Dwarf's API and is not served in this mode.
 */
import type http from 'node:http';
import express, { type Express } from 'express';
import { z } from 'zod';
import { config } from '../../config.js';
import { recentLogs } from '../../log.js';
import type { AgentBridge } from '../../agent/omp.js';
import { displayJpeg } from '../../mcp/tools/common.js';
import { body, rejectCrossSite, route } from '../../web/http.js';
import type { Seestar } from './device.js';
import { listDevices } from './zwo-cloud.js';

export function mountSeestarWeb(app: Express, _server: http.Server, deps: { scope: Seestar; agent: AgentBridge }): { close(): void } {
  const { scope, agent } = deps;
  const api = express.Router();
  api.use(rejectCrossSite);

  api.get('/seestar/status', route(async () => ({ ...scope.state, busy: scope.isBusy(), driver: config.telescope.driver })));
  api.post('/seestar/refresh', route(async () => scope.refreshState()));
  api.get('/seestar/events', route(async () => scope.state.recent));
  api.get('/seestar/logs', route(async () => recentLogs(200)));
  api.post('/seestar/connect', route(async () => scope.connectLink()));
  api.post('/seestar/disconnect', route(async () => scope.release()));
  api.get('/seestar/tunnel', route(async () => scope.tunnel?.status() ?? null));
  api.post('/seestar/tunnel/restart', route(async () => scope.tunnel?.restart()));
  api.get('/seestar/zwo-devices', route(async () => listDevices()));
  api.post(
    '/seestar/rpc',
    route(async (req) => {
      const b = body(req, z.object({ method: z.string().min(1), params: z.unknown().optional() }));
      return scope.raw(b.method, b.params);
    }),
  );
  api.post('/seestar/stop', route(async () => scope.stopView()));
  api.post('/seestar/park', route(async () => scope.park()));
  api.post('/seestar/autofocus', route(async () => scope.autofocus()));
  // blocks until the scope reports the end; the page reads progress and the correction from status.polarAlign
  api.post('/seestar/polar-align', route(async () => scope.polarAlign()));
  api.post('/seestar/polar-align/stop', route(async () => scope.stopPolarAlign()));
  api.post('/seestar/stack/start', route(async () => scope.startStack()));
  api.post('/seestar/stack/stop', route(async () => scope.stopStack()));
  api.get(
    '/seestar/image.jpg',
    route(async (req, res) => {
      const camera = req.query.camera === 'wide' ? 'wide' : 'tele';
      const kind = req.query.kind === 'preview' ? 'preview' : 'stacked';
      const { image } = await scope.grabImage(camera, kind);
      const jpeg = await displayJpeg(image, 1600);
      res.setHeader('Cache-Control', 'no-store');
      res.type('jpeg').send(jpeg);
    }),
  );
  api.get('/agent/status', route(async () => ({ enabled: config.agent.enabled, ...agent.status(), history: agent.history.slice(-40) })));
  api.post(
    '/agent/prompt',
    route(async (req) => {
      const b = body(req, z.object({ text: z.string().min(1) }));
      await agent.prompt(b.text);
    }),
  );
  api.use((req, res) => res.status(404).json({ error: `no such API route: ${req.method} ${req.path}` }));

  app.use('/captures', express.static(config.paths.captures, { maxAge: '1h' }));
  app.use('/api', api);
  app.get(['/', '/index.html'], (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(PAGE);
  });
  return { close: () => {} };
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Astrocontroller · Seestar</title>
<style>
:root{--bg:#0d1014;--fg:#d8dee6;--mut:#8a96a3;--card:#161b21;--line:#26303a;--acc:#c0392b;--ok:#3fa36b;--warn:#d08a2c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);flex-wrap:wrap}
h1{font-size:16px;margin:0}main{display:grid;gap:12px;padding:12px 16px;grid-template-columns:repeat(auto-fit,minmax(320px,1fr))}
section{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;min-width:0}
h2{font-size:13px;margin:0 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
button{background:#222a33;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 10px;cursor:pointer;margin:2px}
button:hover{border-color:var(--mut)}input,textarea{background:#0f1317;color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px;width:100%}
.pill{padding:2px 8px;border-radius:99px;font-size:12px;background:#2a2f36}.ok{background:var(--ok);color:#fff}.bad{background:var(--acc);color:#fff}.wait{background:var(--warn);color:#111}
dl{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;margin:0}dt{color:var(--mut)}dd{margin:0;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:320px;overflow:auto;background:#0f1317;padding:8px;border-radius:6px;font-size:12px;margin:6px 0 0}
img{max-width:100%;border-radius:6px;display:block;margin-top:8px}.chat div{margin:4px 0}.mut{color:var(--mut)}
</style></head><body>
<header><h1>Astrocontroller · Seestar</h1><span id="link" class="pill">…</span><span id="tunnel" class="pill" hidden></span><span id="busy" class="pill" hidden></span>
<span style="flex:1"></span><button onclick="post('connect')">Connect</button><button onclick="post('disconnect')">Disconnect</button></header>
<main>
<section><h2>Scope</h2><dl id="dev"></dl></section>
<section><h2>Control</h2>
<button onclick="post('stop')">Stop</button><button onclick="post('stack/start')">Start stack</button><button onclick="post('stack/stop')">Stop stack</button>
<button onclick="post('autofocus')">Autofocus</button><button onclick="post('park')">Park</button><button onclick="post('refresh')">Refresh</button>
<div style="margin-top:8px"><button id="pa-btn" onclick="polar()" title="EQ mode on a wedge: measure the polar alignment deviation (several minutes)">Polar align</button><button onclick="post('polar-align/stop')">Stop polar align</button></div>
<p id="pa" class="mut" style="margin:6px 0 0">Polar align measures the EQ deviation and says how far to pitch up/down and rotate clockwise/counter-clockwise.</p>
<div style="margin-top:8px"><button onclick="img('stacked')">Stacked image</button><button onclick="img('preview')">Live sub</button><button onclick="img('stacked','wide')">Wide</button></div>
<img id="img" alt="" hidden></section>
<section><h2>Agent</h2><div id="chat" class="chat"></div><textarea id="prompt" rows="2" placeholder="Ask the agent (e.g. plan tonight and start on the best target)"></textarea><button onclick="ask()">Send</button></section>
<section><h2>Raw RPC</h2><input id="m" placeholder="method, e.g. get_device_state"><textarea id="p" rows="2" placeholder='params JSON (optional)'></textarea><button onclick="rpc()">Send</button><pre id="rpcout"></pre></section>
<section><h2>Events</h2><pre id="events"></pre></section>
<section><h2>Tunnel</h2><pre id="tun" class="mut">local connection</pre></section>
<section><h2>Device state</h2><pre id="raw"></pre></section>
</main>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function api(p,o){const r=await fetch('/api/'+p,o);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||r.status);return j}
async function post(p){try{await api('seestar/'+p,{method:'POST'})}catch(e){alert(e.message)}tick()}
async function polar(){if(!confirm('Measure the polar alignment? The Seestar must be tilted on its wedge in EQ mode, with a clear view of the sky.'))return;post('polar-align')}
async function img(kind,camera='tele'){const i=$('img');i.hidden=false;i.src='/api/seestar/image.jpg?kind='+kind+'&camera='+camera+'&t='+Date.now()}
async function rpc(){let params;const t=$('p').value.trim();try{if(t)params=JSON.parse(t)}catch(e){$('rpcout').textContent='params: '+e.message;return}
try{$('rpcout').textContent=JSON.stringify(await api('seestar/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:$('m').value.trim(),params})}),null,1)}catch(e){$('rpcout').textContent=e.message}}
async function ask(){const text=$('prompt').value.trim();if(!text)return;$('prompt').value='';try{await api('agent/prompt',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text})})}catch(e){alert(e.message)}}
const t=ms=>ms?new Date(ms).toLocaleTimeString():'';
async function tick(){try{const s=await api('seestar/status');
const l=$('link');l.textContent=s.released?'released':s.connected?'connected '+(s.link?.host||''):'connecting…';l.className='pill '+(s.connected?'ok':s.released?'':'wait');
const b=$('busy');b.hidden=!s.busy;b.textContent=s.busy||'';b.className='pill wait';
if(s.tunnel){const tu=$('tunnel');tu.hidden=false;tu.textContent='tunnel '+s.tunnel.phase;tu.className='pill '+(s.tunnel.phase==='up'?'ok':s.tunnel.phase==='failed'?'bad':'wait');$('tun').textContent=JSON.stringify(s.tunnel,null,1)}
const d=s.device,m=s.mount,p=s.power,st=s.stack;
const rows=[['Model',d.model],['Name',d.name],['Serial',d.serial],['Firmware',d.firmware],['FOV',s.fov?s.fov.h+'° × '+s.fov.v+'°':''],
['RA / Dec',m.raHours!=null?m.raHours.toFixed(4)+'h  '+m.decDeg.toFixed(3)+'°':''],['Alt / Az',m.altDeg!=null?m.altDeg.toFixed(1)+'°  '+m.azDeg.toFixed(1)+'°':''],
['Mount',[m.eqMode?'EQ':'Alt-Az',m.tracking?'tracking':'',m.parked?'parked':''].filter(Boolean).join(', ')],['Target',s.view.target],['View',[s.view.state,s.view.stage].filter(Boolean).join(' / ')],
['Stack',st.state?st.state+' · '+(st.stacked??0)+' stacked, '+(st.dropped??0)+' dropped':''],['Focuser',s.focus.position!=null?s.focus.position+' / '+(s.focus.maxStep??'?'):''],
['Battery',p.batteryPct!=null?p.batteryPct+'%'+(p.charging?' (charging)':''):''],['Temp',p.tempC!=null?p.tempC+' °C':''],['Free',s.storage.freeMB!=null?s.storage.freeMB+' MB':''],
['Alert',s.alert?.error?s.alert.error+' ('+t(s.alert.at)+')':''],['Link error',s.link?.lastError]];
$('dev').innerHTML=rows.filter(r=>r[1]!==undefined&&r[1]!==''&&r[1]!==null).map(r=>'<dt>'+esc(r[0])+'</dt><dd>'+esc(r[1])+'</dd>').join('');
$('events').textContent=s.recent.slice().reverse().map(e=>t(e.at)+'  '+e.name+(e.state?' '+e.state:'')+(e.error?'  '+e.error:'')).join('\\n');
$('raw').textContent=JSON.stringify(s.deviceState??{},null,1);
const pa=s.polarAlign;$('pa-btn').disabled=!!pa?.running;if(pa?.message){$('pa').textContent=(pa.running?'Polar alignment: ':t(pa.finishedAt||pa.startedAt)+' · ')+pa.message;$('pa').style.color=pa.ok===false?'var(--acc)':''}
const a=await api('agent/status');$('chat').innerHTML=a.enabled?(a.history||[]).slice(-8).map(h=>'<div><b>'+esc(h.kind==='tool'?h.name:h.kind)+'</b> '+esc((h.kind==='tool'?h.status:h.text||'').slice(0,600))+'</div>').join(''):'<span class="mut">agent disabled</span>';
}catch(e){$('link').textContent='server unreachable';$('link').className='pill bad'}}
tick();setInterval(tick,2000);
</script></body></html>`;

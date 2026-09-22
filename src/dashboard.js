import http from 'node:http';
import { Store, STATUSES } from './store.js';
import { listCampaigns, loadCampaign } from './config.js';
import { todayCount, startOfLocalDay } from './limits.js';
import { exportCsv } from './actions/import.js';
import { log } from './log.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function summarise(store, campaignName) {
  const leads = store.leads({ campaign: campaignName });
  const counts = store.counts(campaignName);
  let caps = null, tz = 'Asia/Dubai';
  try { const cfg = loadCampaign(campaignName); caps = cfg.dailyCaps; tz = cfg.workingHours?.timezone || tz; } catch {}
  const today = {
    connects: todayCount(store, 'connects', new Date(), tz),
    messages: todayCount(store, 'messages', new Date(), tz),
    profileViews: todayCount(store, 'profileViews', new Date(), tz),
  };
  const since = startOfLocalDay(new Date(), tz).toISOString();
  const lastStop = [...store.data.actions].reverse().find(a => a.type === 'stopped');
  const weekly = [...store.data.actions].reverse().find(a => a.type === 'weeklyLimit');
  return { leads, counts, caps, today, since, lastStop, weekly };
}

export function renderPage(store, campaignName, campaigns) {
  const s = summarise(store, campaignName);
  const replied = s.leads.filter(l => l.status === 'replied').sort((a, b) => (b.repliedAt || '').localeCompare(a.repliedAt || ''));
  const waiting = s.leads.filter(l => l.status === 'accepted' && !l.queue.length);
  const rows = [...s.leads].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const cap = k => s.caps ? `${s.today[k]} / ${s.caps[k]}` : String(s.today[k]);
  const when = iso => iso ? new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
  const chip = st => `<span class="chip chip-${st}">${st}</span>`;
  const row = l => `<tr data-status="${l.status}">
    <td><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.name || l.url.replace('https://www.linkedin.com/in/', ''))}</a><div class="sub">${esc(l.headline)}</div></td>
    <td>${chip(l.status)}${l.queue?.length ? `<div class="sub">${l.queue.length} queued</div>` : ''}</td>
    <td><label class="ok"><input type="checkbox" data-url="${esc(l.url)}" ${l.approved ? 'checked' : ''} ${l.status !== 'new' ? 'disabled' : ''}> approved</label></td>
    <td class="sub">${l.messages.length} sent${l.invitedAt ? `<br>invited ${when(l.invitedAt)}` : ''}${l.acceptedAt ? `<br>accepted ${when(l.acceptedAt)}` : ''}</td>
    <td class="sub">${esc(l.lastReply || l.error || l.notes || '')}</td>
  </tr>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sourcer</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--ink:#16181d;--muted:#6b7280;--line:#e5e7eb;--accent:#1f4fd8;--ok:#0f8a4b;--warn:#b45309;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--ink:#e6e8ee;--muted:#9aa3b2;--line:#262a33;--accent:#7aa2ff;--ok:#3ecf8e;--warn:#f5b048;--bad:#ff6b6b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:24px 16px}
h1{font-size:20px;margin:0 0 4px}.top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap;margin-bottom:18px}
select{font:inherit;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat b{display:block;font-size:22px;font-weight:600}.stat span{color:var(--muted);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:14px}
.card h2{font-size:14px;margin:0 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:12px;color:var(--muted);font-weight:600;padding:8px 6px;border-bottom:1px solid var(--line)}
td{padding:9px 6px;border-bottom:1px solid var(--line);vertical-align:top}a{color:var(--accent);text-decoration:none}.sub{color:var(--muted);font-size:12px}
.chip{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--line)}
.chip-replied{background:var(--ok);color:#fff;border-color:transparent}.chip-accepted{color:var(--ok);border-color:var(--ok)}.chip-invited{color:var(--accent);border-color:var(--accent)}
.chip-error{color:var(--bad);border-color:var(--bad)}.chip-skipped,.chip-done{color:var(--muted)}
.alert{border-left:3px solid var(--warn);padding:8px 12px;background:var(--card);border-radius:6px;margin-bottom:14px}
.filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.filters button{font:inherit;font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.filters button.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
label.ok{color:var(--muted);font-size:12px;white-space:nowrap}
.reply{padding:8px 0;border-bottom:1px solid var(--line)}.reply:last-child{border:0}.reply q{display:block;margin-top:2px;color:var(--ink)}
@media (max-width:640px){td:nth-child(4),th:nth-child(4){display:none}}
</style></head><body><div class="wrap">
<div class="top"><div><h1>Sourcer</h1><div class="sub">Campaign activity. Today resets at midnight Dubai time.</div></div>
<div><select id="camp" onchange="location='/?c='+this.value">${campaigns.map(c => `<option ${c === campaignName ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
<a class="sub" style="margin-left:10px" href="/export.csv?c=${encodeURIComponent(campaignName)}">Export CSV</a></div></div>
${s.lastStop && s.lastStop.at > s.since ? `<div class="alert"><b>Stopped today:</b> ${esc(s.lastStop.reason)}</div>` : ''}
${s.weekly && Date.now() - new Date(s.weekly.at).getTime() < 7 * 86400000 ? `<div class="alert"><b>Weekly invitation limit hit</b> on ${when(s.weekly.at)}. Connection requests pause until LinkedIn resets it.</div>` : ''}
<div class="stats">
<div class="stat"><b>${cap('connects')}</b><span>connects today</span></div>
<div class="stat"><b>${cap('messages')}</b><span>messages today</span></div>
<div class="stat"><b>${cap('profileViews')}</b><span>profile views today</span></div>
<div class="stat"><b>${s.counts.invited}</b><span>invites pending</span></div>
<div class="stat"><b>${s.counts.accepted + s.counts.messaged}</b><span>connected</span></div>
<div class="stat"><b>${s.counts.replied}</b><span>replied</span></div>
</div>
${replied.length ? `<div class="card"><h2>Replies</h2>${replied.slice(0, 20).map(l => `<div class="reply"><a href="${esc(l.url)}" target="_blank">${esc(l.name)}</a> <span class="sub">${when(l.repliedAt)}</span><q>${esc(l.lastReply)}</q></div>`).join('')}</div>` : ''}
${waiting.length ? `<div class="card"><h2>Accepted, waiting for a first message</h2><div class="sub">${waiting.length} people. Research each one, pick the route, queue the message.</div>${waiting.map(l => `<div class="reply"><a href="${esc(l.url)}" target="_blank">${esc(l.name)}</a> <span class="sub">${esc(l.headline)}</span></div>`).join('')}</div>` : ''}
<div class="card"><h2>All leads (${s.leads.length})</h2>
<div class="filters"><button class="on" data-f="">all</button>${STATUSES.map(st => `<button data-f="${st}">${st} ${s.counts[st] || 0}</button>`).join('')}</div>
<table><thead><tr><th>Person</th><th>Status</th><th>Approved</th><th>Activity</th><th>Last reply / note</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>
</div>
<script>
document.querySelectorAll('.filters button').forEach(b=>b.onclick=()=>{document.querySelectorAll('.filters button').forEach(x=>x.classList.remove('on'));b.classList.add('on');const f=b.dataset.f;document.querySelectorAll('tbody tr').forEach(tr=>tr.style.display=(!f||tr.dataset.status===f)?'':'none')});
document.querySelectorAll('input[type=checkbox][data-url]').forEach(cb=>cb.onchange=async()=>{await fetch('/api/approve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:cb.dataset.url,approved:cb.checked})})});
</script></body></html>`;
}

export function startDashboard({ port = 4747 } = {}) {
  const server = http.createServer(async (req, res) => {
    const store = new Store();
    const u = new URL(req.url, 'http://localhost');
    const campaigns = listCampaigns();
    const c = u.searchParams.get('c') || campaigns[0] || 'default';
    try {
      if (req.method === 'GET' && u.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(renderPage(store, c, campaigns.length ? campaigns : [c]));
      }
      if (req.method === 'GET' && u.pathname === '/api/leads') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(store.leads({ campaign: c })));
      }
      if (req.method === 'GET' && u.pathname === '/export.csv') {
        res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': `attachment; filename="${c}.csv"` });
        return res.end(exportCsv(store, { name: c }));
      }
      if (req.method === 'POST' && u.pathname === '/api/approve') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const { url, approved } = JSON.parse(body || '{}');
        const lead = store.get(url);
        if (!lead) { res.writeHead(404); return res.end('no such lead'); }
        lead.approved = !!approved;
        store.save();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      res.writeHead(500); res.end(String(e.message));
    }
  });
  server.on('error', e => {
    if (e.code === 'EADDRINUSE') log(`dashboard already running at http://localhost:${port} (nothing to do)`);
    else log('dashboard error', e.message);
  });
  server.listen(port, '127.0.0.1', () => log(`dashboard on http://localhost:${port}`));
  return server;
}

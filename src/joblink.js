// Reads a job link into the exact title, location, work type, company and spec text.
// 24 Sep 2026: a pasted Lever link used to become the role's title, link and all. Lever, Greenhouse
// and Ashby each publish their postings as open JSON, so the title comes from the job board itself
// rather than a guess. Anything else: Sourcer says so, and Kai pastes the text instead.

const TIMEOUT_MS = 15000;

// Which board a link belongs to, and the public address of its data.
export function jobLinkSource(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean);
  // jobs.lever.co/{company}/{id}[/apply]
  if (host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    if (seg.length < 2) return null;
    const api = host === 'jobs.eu.lever.co' ? 'https://api.eu.lever.co' : 'https://api.lever.co';
    return { board: 'lever', company: seg[0], id: seg[1], api: `${api}/v0/postings/${encodeURIComponent(seg[0])}/${encodeURIComponent(seg[1])}` };
  }
  // boards.greenhouse.io/{board}/jobs/{id}, job-boards.greenhouse.io/{board}/jobs/{id}
  if (/(^|\.)greenhouse\.io$/.test(host)) {
    const j = seg.indexOf('jobs');
    const board = seg[0], id = j >= 0 ? seg[j + 1] : u.searchParams.get('gh_jid');
    if (!board || !id || !/^\d+$/.test(id)) return null;
    return { board: 'greenhouse', company: board, id, api: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${id}` };
  }
  // jobs.ashbyhq.com/{org}/{uuid}
  if (host === 'jobs.ashbyhq.com') {
    if (seg.length < 2) return null;
    return { board: 'ashby', company: seg[0], id: seg[1], api: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(seg[0])}?includeCompensation=true` };
  }
  return null;
}

export const isJobLink = text => /^https?:\/\/\S+$/i.test(String(text || '').trim());

// HTML to plain text, keeping list items and paragraphs on their own lines.
const decode = t => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
export function htmlToText(html, { escaped = false } = {}) {
  let t = String(html || '');
  // Greenhouse sends its HTML escaped once more ("&lt;p&gt;Protect &amp;amp; defend"): undo that first
  if (escaped) t = decode(t);
  return decode(t
    .replace(/<\s*(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<[^>]+>/g, ''))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const nice = s => String(s || '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim();
const workFrom = (x = '') => { const t = String(x).toLowerCase(); return /hybrid/.test(t) ? 'hybrid' : /remote/.test(t) ? 'remote' : /on[- ]?site|in[- ]?office/.test(t) ? 'onsite' : ''; };

// { title, location, workType, company, board, text } or throws with a plain reason.
export async function readJobLink(url, { fetchImpl = globalThis.fetch } = {}) {
  const src = jobLinkSource(url);
  if (!src) throw new Error('Sourcer can read Lever, Greenhouse and Ashby job links. For any other site, paste the job text instead.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let j;
  try {
    const res = await fetchImpl(src.api, { signal: ctl.signal, headers: { accept: 'application/json' }, redirect: 'error' });
    if (res.status === 404) throw new Error(`${nice(src.board)} says that job does not exist any more. Paste the job text instead.`);
    if (!res.ok) throw new Error(`${nice(src.board)} answered ${res.status}. Paste the job text instead.`);
    // read inside the timeout: a stalled answer cannot hang the page
    const body = typeof res.text === 'function' ? await res.text() : JSON.stringify(await res.json());
    if (body.length > 5_000_000) throw new Error(`${nice(src.board)} sent far more than a job. Paste the job text instead.`);
    j = JSON.parse(body);
  } catch (e) {
    if (/Paste the job text/.test(e.message)) throw e;
    const why = e.name === 'AbortError' ? 'it took too long' : e.message;
    throw new Error(`${e instanceof SyntaxError ? 'Could not read' : 'Could not reach'} ${nice(src.board)} (${why}). Paste the job text instead.`);
  } finally { clearTimeout(timer); }

  if (src.board === 'lever') {
    const lists = (j.lists || []).map(l => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
    const text = [j.text, j.categories?.location, j.descriptionPlain || htmlToText(j.description), lists, j.additionalPlain || htmlToText(j.additional)].filter(Boolean).join('\n\n');
    return { board: 'lever', title: j.text || '', location: j.categories?.location || '', workType: workFrom(j.workplaceType || j.categories?.commitment), company: nice(src.company), text };
  }
  if (src.board === 'greenhouse') {
    const body = htmlToText(j.content, { escaped: true });
    const text = [j.title, j.location?.name, body].filter(Boolean).join('\n\n');
    return { board: 'greenhouse', title: j.title || '', location: j.location?.name || '', workType: workFrom(`${j.location?.name || ''} ${body.slice(0, 2000)}`), company: j.company_name || nice(src.company), text };
  }
  // ashby: the board lists every job; the link's id picks one
  const job = (j.jobs || []).find(x => x.id === src.id || String(x.jobUrl || '').includes(src.id));
  if (!job) throw new Error('Ashby does not list that job any more. Paste the job text instead.');
  const text = [job.title, job.location, job.descriptionPlain || htmlToText(job.descriptionHtml)].filter(Boolean).join('\n\n');
  return { board: 'ashby', title: job.title || '', location: job.location || '', workType: job.isRemote ? 'remote' : workFrom(job.workplaceType), company: nice(src.company), text };
}

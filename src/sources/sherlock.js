// Sherlock's audit contest leaderboard. One open JSON endpoint, no key. Forty-one entries carry
// Sherlock's own senior grade, thirty-five of them individuals rather than teams, which is exactly
// the level we work at.
//
// These people are pseudonymous and mostly stay that way. About a quarter have linked a Twitter
// account, but the board only shows that they did, not which account, so the last step is opening
// their Sherlock page yourself. Treat this source as "who is worth chasing", not "who to email".
import { getJson } from './http.js';
import { find } from './shape.js';
import { mayFetch , HOSTS } from './registry.js';
import { log } from '../log.js';

const URL = 'https://mainnet-contest.sherlock.xyz/stats/leaderboard';

// Checked against the live board on 24 Sep 2026: a picture served from twitter_images/ means the
// person linked a Twitter account, but the filename is a UUID, so the handle itself is NOT in
// there. It tells us they have a public identity somewhere, not what it is.
export const linkedTwitter = pictureUrl => /\/twitter_images\//.test(String(pictureUrl || ''));

export function toFinds(board, { seniorOnly = false, minPayout = 0 } = {}) {
  const rows = Array.isArray(board) ? board
    : (board && typeof board === 'object') ? Object.entries(board).map(([handle, v]) => ({ handle, ...(v && typeof v === 'object' ? v : {}) }))
    : [];   // a string body means the site answered with something that is not a leaderboard
  return rows
    .filter(r => r && typeof r.handle === 'string' && r.handle && !r.is_team)                                   // a team is not a person to call
    .filter(r => (!seniorOnly || r.senior) && (r.payout || 0) >= minPayout)
    .map(r => find('sherlock', {
      handle: r.handle,
      url: `https://audits.sherlock.xyz/watson/${encodeURIComponent(r.handle)}`,
      evidence: [
        { label: 'paid for findings', value: `$${Math.round(r.payout || 0).toLocaleString('en-GB')}` },
        { label: 'rank', value: String(r.ranking ?? '') },
        ...(r.senior ? [{ label: 'graded senior by Sherlock', value: `tier ${r.senior_tier ?? '?'}` }] : []),
        ...(r.days ? [{ label: 'days competing', value: String(r.days) }] : []),
        ...(linkedTwitter(r.profile_picture_url)
          ? [{ label: 'has a linked Twitter', value: 'open their Sherlock page to see who' }] : []),
      ],
      // senior grade is their own judgement and worth more than raw money
      weight: r.senior ? 95 : Math.min(85, 40 + Math.round(Math.log10((r.payout || 1) + 1) * 12)),
    }))
    .sort((a, b) => b.weight - a.weight);
}

export async function searchSherlock({ seniorOnly = true, minPayout = 0, fetchImpl } = {}) {
  mayFetch('sherlock');
  const board = await getJson(URL, { source: 'sherlock', gapMs: 2000, allowHosts: HOSTS.sherlock, timeoutMs: 45000, fetchImpl });
  const out = toFinds(board, { seniorOnly, minPayout });
  log(`sherlock: ${out.length} auditors${seniorOnly ? ' graded senior' : ''}`);
  return out;
}

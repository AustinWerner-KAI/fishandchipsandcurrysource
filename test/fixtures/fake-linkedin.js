// A tiny fake of the LinkedIn pages Sourcer touches, using the same markup shapes as selectors.js.
import http from 'node:http';

const profile = (slug, { degree = '2nd', pending = false, name = 'Ann Example', connectUnderMore = false, company = '' } = {}) => `<!doctype html><html><body>
<nav id="global-nav">nav</nav>
<main>
<section class="pv-top-card">
<h1 class="text-heading-xlarge">${name}</h1>
<span class="dist-value">${degree}</span>
<div class="text-body-medium break-words">Head of Talent at Example Labs</div>
${company ? `<button aria-label="Current company: ${company}. Click to skip to experience card"><span>${company}</span></button><a href="https://www.linkedin.com/company/krakenfx/">${company}</a>` : ''}
<div class="pvs-profile-actions">
${degree === '1st' ? `<button aria-label="Message ${name}"><span>Message</span></button>` :
  pending ? `<button aria-label="Pending, click to withdraw invitation sent to ${name}"><span>Pending</span></button>` :
  connectUnderMore ? `<button aria-label="Follow ${name}"><span>Follow</span></button>` :
  `<button aria-label="Invite ${name} to connect"><span>Connect</span></button>`}
<button aria-label="More actions"><span>More</span></button>
<div id="more-menu" style="display:none" class="artdeco-dropdown__content">
  ${connectUnderMore ? `<div role="button" aria-label="Invite ${name} to connect">Connect</div>` : ''}
  <div role="button" aria-label="Report or block">Report</div>
</div>
</div>
</section>
<section class="pv-profile-card"><h2>People you may know</h2>
  <ul><li><a href="/in/stranger-one/">Stranger One</a><button aria-label="Invite Stranger One to connect"><span>Connect</span></button></li>
      <li><a href="/in/stranger-two/">Stranger Two</a><button aria-label="Message Stranger Two"><span>Message</span></button></li></ul>
</section>
</main>
<div id="modal" style="display:none" class="artdeco-modal">
  <button aria-label="Add a note">Add a note</button>
  <textarea id="custom-message" name="message" style="display:none"></textarea>
  <button aria-label="Send without a note">Send without a note</button>
  <button aria-label="Send invitation" style="display:none">Send</button>
  <button aria-label="Dismiss">x</button>
</div>
<div id="overlay" style="display:none" class="msg-overlay-conversation-bubble">
  <div class="msg-overlay-bubble-header"><div class="msg-overlay-bubble-header__controls"><button>min</button><button data-control-name="overlay.close_conversation_window">close</button></div></div>
  <div id="thread">
    <div class="msg-s-message-group"><span class="msg-s-message-group__name">${name}</span><p class="msg-s-event-listitem__body">Thanks for the invite!</p></div>
  </div>
  <form class="msg-form"><div class="msg-form__contenteditable" contenteditable="true" role="textbox"></div><button type="button" class="msg-form__send-button">Send</button></form>
</div>
<script>
const $=s=>document.querySelector(s);
$('button[aria-label="Add a note"]').onclick=()=>{$('#custom-message').style.display='block';$('button[aria-label="Send without a note"]').style.display='none';$('button[aria-label="Send invitation"]').style.display='inline'};
const sent=()=>{$('#modal').style.display='none';window.__note=$('#custom-message').value;window.__invited=(window.__invited||[]).concat(window.__clicked);const top=$('.pv-top-card .pvs-profile-actions');const old=top.querySelector('button[aria-label^="Invite"],button[aria-label^="Follow"]');const b=document.createElement('button');b.setAttribute('aria-label','Pending, click to withdraw');b.innerHTML='<span>Pending</span>';old.replaceWith(b)};
document.querySelectorAll('[aria-label^="Invite"]').forEach(el=>el.addEventListener('click',()=>{window.__clicked=el.getAttribute('aria-label');$('#modal').style.display='block'}));
$('button[aria-label="More actions"]').onclick=()=>{$('#more-menu').style.display='block'};
$('button[aria-label="Send invitation"]').onclick=sent;$('button[aria-label="Send without a note"]').onclick=sent;
const msg=$('button[aria-label^="Message"]');
if(msg) msg.onclick=()=>{$('#overlay').style.display='block'};
$('.msg-form__send-button').onclick=()=>{const ed=$('.msg-form__contenteditable');window.__sent=(window.__sent||[]).concat(ed.innerText);$('#thread').insertAdjacentHTML('beforeend','<div class="msg-s-message-group"><span class="msg-s-message-group__name">Kai Crayford</span><p class="msg-s-event-listitem__body">'+ed.innerText+'</p></div>');ed.innerText=''};
$('button[data-control-name="overlay.close_conversation_window"]').onclick=()=>{$('#overlay').style.display='none'};
</script></body></html>`;

// LinkedIn's newer layout: no h1, no top-card classes, a plain "Connect" button, and a
// "More profiles for you" column with Connect buttons of its own.
const modern = () => `<!doctype html><html><head><title>(7) Eve Modern | LinkedIn</title></head><body>
<nav id="global-nav">nav</nav>
<main><div class="cols">
  <div class="left"><div class="card">
    <div><p><span>Eve Modern</span> <span>· 2nd</span></p><p>Sr. Security Engineer</p></div>
    <div><button id="c1"><span>Connect</span></button><button><span>View in Recruiter</span></button><button aria-label="More actions"><span>…</span></button></div>
  </div></div>
  <aside class="right"><h2>More profiles for you</h2>
    <div><span>Stranger Three</span><button id="s1" aria-label="Invite Stranger Three to connect"><span>Connect</span></button></div>
    <div><span>Stranger Four</span><button id="s2"><span>Connect</span></button></div>
  </aside></div></main>
<div id="modal" style="display:none" class="artdeco-modal">
  <button aria-label="Add a note">Add a note</button><textarea id="custom-message" name="message" style="display:none"></textarea>
  <button aria-label="Send invitation" style="display:none">Send</button><button aria-label="Dismiss">x</button></div>
<script>
const $=s=>document.querySelector(s);
document.querySelectorAll('button[id]').forEach(b=>b.onclick=()=>{window.__clicked=b.id;$('#modal').style.display='block'});
$('button[aria-label="Add a note"]').onclick=()=>{$('#custom-message').style.display='block';$('button[aria-label="Send invitation"]').style.display='inline'};
$('button[aria-label="Send invitation"]').onclick=()=>{$('#modal').style.display='none';window.__invited=(window.__invited||[]).concat(window.__clicked);window.__note=$('#custom-message').value;$('#c1').outerHTML='<button><span>Pending</span></button>'};
</script></body></html>`;

// Recruiter Lite profile + InMail composer, as Kai's recording shows it (22 Sep 2026)
const recruiterProfile = () => `<!doctype html><html><head><title>Nathan Test | Recruiter</title></head><body>
<nav id="global-nav">nav</nav>
<main>
  <h1>Nathan Test</h1>
  <button data-test-component="message-icon-btn" aria-label="Message Nathan"><span>Message</span></button>
  <div id="slot"></div>
</main>
<script>
const $=s=>document.querySelector(s);
$('button[data-test-component="message-icon-btn"]').onclick=()=>{
  $('#slot').innerHTML = \`<div class="messaging-composer"><div class="multi-message-composer">
    <div class="ts-common-typeahead"><input class="artdeco-typeahead__input ts-common-typeahead__input" type="text" aria-label="Search template"></div>
    <input type="text" class="compose-subject__input" data-test-compose-subject-input aria-label="Message subject" placeholder="Add a subject">
    <div class="rich-text-editor__editor-elem ql-container"><div class="ql-editor" contenteditable="true" role="textbox" style="min-height:120px;display:block"><p><br></p></div></div>
    </div>
    <div class="compose-actions"><span data-test-inmail-credits-text>1/84 InMail Credits</span>
      <button class="artdeco-button--primary" data-test-messaging-submit-btn><span>Send this message</span> Send</button>
      <button aria-label="Dismiss">x</button></div></div>\`;
  $('button[data-test-messaging-submit-btn]').onclick=()=>{
    window.__inmail={subject:$('.compose-subject__input').value, body:$('.ql-editor').innerText, template:$('.ts-common-typeahead__input').value};
    $('#slot').innerHTML='<div>Message sent</div>';
  };
};
</script></body></html>`;

// Recruiter's "Start a search" page as Kai's account served it on 24 Sep 2026. Like the real one it
// changes layout by width: below 1200px the search box shrinks to the magnifier in the top bar and
// the filter rail (Locations, Skills) disappears. That is what made a narrow search tab fail.
const recruiterEmptySearch = () => `<!doctype html><html><head><title>Recruiter Lite</title><style>
@media (max-width: 1199px) {
  .ts-common-typeahead:not(.open) { display: none; }
  .left-rail { display: none; }
}
</style></head><body>
<div class="global-nav__right">
  <div data-test-system-search-typeahead class="system-search-typeahead global-nav__system-search">
    <div class="system-search-typeahead__icon-container"><span>search</span></div>
    <div class="ts-common-typeahead">
      <input id="system-search-typeahead" placeholder="Start a new search…" type="text"
             aria-label="Search by job title, ideal candidate, keyword, or boolean">
    </div>
  </div>
</div>
<aside aria-label="Search filters" class="left-rail">
  <div class="search-facet-wrapper facet-locations"><button data-test-facet-edit>Locations</button></div>
  <div class="search-facet-wrapper facet-skills"><button data-test-facet-edit>Skills</button></div>
</aside>
<main><h2>Start a search</h2><p>You haven't started a search yet.</p></main>
<script>
document.querySelector('.system-search-typeahead__icon-container').onclick = () => {
  document.querySelector('.ts-common-typeahead').classList.add('open');
};
</script></body></html>`;

export function startFake(port = 4790) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (u.pathname.startsWith('/in/connected')) return res.end(profile('connected', { degree: '1st', name: 'Bob Connected' }));
    if (u.pathname.startsWith('/in/pending')) return res.end(profile('pending', { pending: true }));
    if (u.pathname.startsWith('/in/follow-first')) return res.end(profile('follow-first', { connectUnderMore: true, name: 'Cara Follow' }));
    if (u.pathname.startsWith('/talent/profile')) return res.end(recruiterProfile());
    if (u.pathname.startsWith('/talent/search')) return res.end(recruiterEmptySearch());
    if (u.pathname.startsWith('/in/modern')) return res.end(modern());
    if (u.pathname.startsWith('/in/at-client')) return res.end(profile('at-client', { name: 'Dee Client', company: 'Kraken' }));
    if (u.pathname.startsWith('/in/')) return res.end(profile('ann'));
    res.end('<main>nothing</main>');
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

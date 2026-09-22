// A tiny fake of the LinkedIn pages Sourcer touches, using the same markup shapes as selectors.js.
import http from 'node:http';

const profile = (slug, { degree = '2nd', pending = false, name = 'Ann Example' } = {}) => `<!doctype html><html><body>
<nav id="global-nav">nav</nav>
<main>
<h1 class="text-heading-xlarge">${name}</h1>
<span class="dist-value">${degree}</span>
<div class="text-body-medium break-words">Head of Talent at Example Labs</div>
<div class="pvs-profile-actions">
${degree === '1st' ? `<button aria-label="Message ${name}"><span>Message</span></button>` :
  pending ? `<button aria-label="Pending, click to withdraw invitation sent to ${name}"><span>Pending</span></button>` :
  `<button aria-label="Invite ${name} to connect"><span>Connect</span></button>`}
<button aria-label="More actions"><span>More</span></button>
</div>
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
const connect=$('button[aria-label^="Invite"]');
if(connect) connect.onclick=()=>{$('#modal').style.display='block'};
$('button[aria-label="Add a note"]').onclick=()=>{$('#custom-message').style.display='block';$('button[aria-label="Send without a note"]').style.display='none';$('button[aria-label="Send invitation"]').style.display='inline'};
const sent=()=>{$('#modal').style.display='none';window.__note=$('#custom-message').value;const b=$('button[aria-label^="Invite"]');b.setAttribute('aria-label','Pending, click to withdraw');b.innerHTML='<span>Pending</span>'};
$('button[aria-label="Send invitation"]').onclick=sent;$('button[aria-label="Send without a note"]').onclick=sent;
const msg=$('button[aria-label^="Message"]');
if(msg) msg.onclick=()=>{$('#overlay').style.display='block'};
$('.msg-form__send-button').onclick=()=>{const ed=$('.msg-form__contenteditable');window.__sent=(window.__sent||[]).concat(ed.innerText);$('#thread').insertAdjacentHTML('beforeend','<div class="msg-s-message-group"><span class="msg-s-message-group__name">Kai Crayford</span><p class="msg-s-event-listitem__body">'+ed.innerText+'</p></div>');ed.innerText=''};
$('button[data-control-name="overlay.close_conversation_window"]').onclick=()=>{$('#overlay').style.display='none'};
</script></body></html>`;

export function startFake(port = 4790) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'text/html');
    if (u.pathname.startsWith('/in/connected')) return res.end(profile('connected', { degree: '1st', name: 'Bob Connected' }));
    if (u.pathname.startsWith('/in/pending')) return res.end(profile('pending', { pending: true }));
    if (u.pathname.startsWith('/in/')) return res.end(profile('ann'));
    res.end('<main>nothing</main>');
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

// Job brief -> confirmed requirements -> external LinkedIn people searches.
let fileReadVersion = 0;
const previousStartNewRole = startNewRole;
startNewRole = function () {
  fileReadVersion++;
  previousStartNewRole();
  $('#specReadStatus').textContent = '';
  $('#readSpecButton').disabled = false;
};

function readSpecDetails() {
  const text = $('#newSpec').value.trim();
  if (text.length < 30) {
    $('#registrationError').textContent = 'Paste or upload the full job specification first (at least 30 characters).';
    $('#newSpec').focus();
    return;
  }
  const draft = roleEngine.draftRole(text);
  $('#newTitle').value = draft.title;
  $('#newLocation').value = draft.location;
  $('#newWorkType').value = { onsite: 'On-site', hybrid: 'Hybrid', remote: 'Remote' }[draft.workType] || 'Hybrid';
  $('#newSkills').value = [...new Set([...(draft.recruiterSkills || []), ...(draft.skills || [])])].join(', ');
  $('#registrationError').textContent = '';
  $('#specReadStatus').textContent = 'Brief read. Check the suggested title, location and essential skills below, and fill any blanks before continuing.';
}

$('#specFile').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  const version = ++fileReadVersion;
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['txt', 'pdf', 'docx'].includes(extension) || file.size > 10 * 1024 * 1024) {
    $('#registrationError').textContent = 'Choose a PDF, Word (.docx) or text file under 10 MB.';
    $('#readSpecButton').disabled = false;
    $('#specReadStatus').textContent = '';
    return;
  }
  $('#readSpecButton').disabled = true;
  $('#specReadStatus').textContent = 'Reading ' + file.name + '…';
  $('#registrationError').textContent = '';
  try {
    let text;
    if (extension === 'txt') text = await file.text();
    if (extension === 'docx') text = (await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() })).value;
    if (extension === 'pdf') {
      const pdfjs = await import('./vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', document.baseURI).href;
      const documentTask = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
      try {
        const pdf = await documentTask.promise;
        if (pdf.numPages > 100) throw new Error('Use a specification with 100 pages or fewer.');
        const pages = [];
        for (let n = 1; n <= pdf.numPages; n++) {
          const content = await (await pdf.getPage(n)).getTextContent();
          pages.push(content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join(''));
        }
        text = pages.join('\n');
      } finally { await documentTask.destroy(); }
    }
    if (version !== fileReadVersion) return;
    if (!text || text.trim().length < 30) throw new Error('No readable specification found. For scanned PDFs, paste the text instead.');
    $('#newSpec').value = text;
    readSpecDetails();
    $('#specReadStatus').textContent = file.name + ' loaded. Check the suggested details below before continuing.';
  } catch (error) {
    if (version !== fileReadVersion) return;
    $('#registrationError').textContent = 'Could not read this file. Paste the specification instead. ' + error.message;
    $('#specReadStatus').textContent = '';
  } finally {
    if (version === fileReadVersion) $('#readSpecButton').disabled = false;
  }
});

function renderSearchLinks(role) {
  const geo = roleEngine.lookupGeo(role.location);
  $('#locationSearchNote').textContent = geo
    ? 'Location filter: ' + role.location + '. Review the filters on LinkedIn before using the results.'
    : 'Set the location filter to “' + role.location + '” on LinkedIn. It could not be applied automatically.';
  $('#searchLaunchStatus').textContent = 'Ready to open your tailored searches.';
  for (const [id, query] of [['runSearchOne', role.queryOne], ['runSearchTwo', role.queryTwo]]) {
    const link = document.getElementById(id);
    link.href = roleEngine.buildSearchUrl(query, geo ? [geo] : []);
    link.onclick = () => {
      $('#searchLaunchStatus').textContent = 'Search link opened. Continue on LinkedIn; Sourcer cannot confirm or import the results from this page.';
    };
  }
}

connectLinkedIn = function () {
  window.open('https://www.linkedin.com/login', '_blank', 'noopener,noreferrer');
  toast('Sign in on LinkedIn, then use a tailored search. This does not connect automated sourcing.');
};
$('#linkedInLabel').replaceChildren(document.createTextNode('Sign in on LinkedIn'));
const loginHint = document.createElement('small');
loginHint.textContent = 'Opens LinkedIn in a new tab';
$('#linkedInLabel').append(loginHint);

$('main').prepend($('.topbar'));
// Start at the actual sourcing task, not the sample candidate dashboard.
if (activeRole) {
  selectSavedRole(activeRole.id);
} else {
  startNewRole();
}

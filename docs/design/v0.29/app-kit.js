ICONS.channel = '<path d="M5 20.5V11A7 7 0 0 1 12 4h0.5A7 7 0 0 1 19.5 11v2.5A7 7 0 0 1 12.5 20.5Z"/>';
const I = (n, c = '') => `<svg class="i ${c}" viewBox="0 0 24 24">${ICONS[n] || ''}</svg>`;
const q = new URLSearchParams(location.search);
if (q.get('t') === 'dark') document.documentElement.classList.add('dark');
const LOGO = (arch = '#F3EEE2') => `<svg viewBox="0 0 48 48"><path fill="none" stroke="${arch}" stroke-width="6.5" stroke-linecap="round" d="M10 41V22A14 14 0 0 1 38 22V41"/><path fill="#C9A24B" d="M17.5 33V25.5A5.5 5.5 0 0 1 23 20H25A5.5 5.5 0 0 1 30.5 25.5V27.5A5.5 5.5 0 0 1 25 33Z"/></svg>`;
const AV = { 'Ayşe Yılmaz': ['AY', 'a1'], 'Mert Demir': ['MD', 'a2'], 'Zeynep Ak': ['ZA', 'a3'], 'Deniz Kaya': ['DK', 'a4'], 'Can Öztürk': ['CÖ', 'a5'] };
const av = (n, cls = '', pr = '') => `<span class="av ${AV[n][1]} ${cls}">${AV[n][0]}${pr ? `<i class="pr ${pr}"></i>` : ''}</span>`;


const rail = () => `<nav class="rail" aria-label="Workspaces"><div class="ws on" title="Cenacle">${LOGO()}</div><div class="ws" title="Operations">Op</div><div class="ws" title="Design">De</div><div class="ws add" title="Add a workspace">${I('plus', 's')}</div><div class="grow"></div><span class="iconbtn" style="color:#a9b5ae">${I('settings')}</span></nav>`;
// sel: inbox | threads | saved | tasks | general | design-review | release-rc | random | central | none
const side = (sel = 'general') => { const r = (key, cls, inner) => `<div class="row ${sel === key ? 'sel' : cls}">${inner}</div>`;
  return `<aside class="side">
  <div class="wsname"><b>Cenacle ${I('chevron-down', 's')}</b><span class="iconbtn" title="New message">${I('square-pen')}</span></div>
  <div class="jump">${I('search', 's')} Jump to… <kbd>Ctrl K</kbd></div>
  <div class="nav">
    ${r('inbox', 'unread', `${I('inbox')}<span class="n">Inbox</span><span class="badge">4</span>`)}
    ${r('threads', 'unread', `${I('message-circle-reply')}<span class="n">Threads</span><span class="meta">New replies</span><span class="dot"></span>`)}
    ${r('saved', '', `${I('bookmark')}<span class="n">Saved</span>`)}
    ${r('tasks', '', `${I('list-checks')}<span class="n">Tasks</span><span class="meta tab">4 open</span>`)}
    <div class="sec"><span>${I('chevron-down', 's')}Channels</span>${I('plus', 's')}</div>
    ${r('central', '', `${I('megaphone')}<span class="n">Central</span><span class="meta">Announcements</span>`)}
    ${r('general', '', `${I('channel')}<span class="n">General</span>`)}
    ${r('design-review', 'unread', `${I('channel')}<span class="n">design-review</span><span class="draft">${I('square-pen', 's')}Draft</span><span class="dot"></span>`)}
    ${r('release-rc', 'unread', `${I('lock')}<span class="n">release-rc</span><span class="badge">2</span>`)}
    ${r('random', '', `${I('channel')}<span class="n">random</span>`)}
    <div class="sec"><span>${I('chevron-down', 's')}Direct messages</span>${I('plus', 's')}</div>
    <div class="row">${av('Ayşe Yılmaz', '', 'on')}<span class="n">Ayşe Yılmaz</span></div>
    <div class="row unread">${av('Mert Demir', '', 'away')}<span class="n">Mert Demir</span><span class="badge">1</span></div>
    <div class="row">${I('users')}<span class="n">Zeynep Ak, Deniz Kaya</span></div>
    <div class="sec"><span>${I('chevron-right', 's')}More</span><span class="meta" style="font-weight:400">Events, playbooks, workflows</span></div>
  </div>
  <div class="conn"><i></i>Connected</div>
  <div class="me">${av('Deniz Kaya', 'l', 'on')}<div style="flex:1;min-width:0"><b>Deniz Kaya</b><span class="meta">Focusing until 15:00</span></div><span class="iconbtn" title="Notifications">${I('bell')}</span></div>
</aside>`; };
// A full app screen: shell(sel, mainHtml, rightPanelHtml?)
const shell = (sel, main, right = '') => `<div class="app" style="${right ? '' : 'grid-template-columns:64px 256px minmax(0,1fr)'}">${rail()}${side(sel)}<main class="main">${main}</main>${right}</div>`;

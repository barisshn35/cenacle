// SPDX-License-Identifier: AGPL-3.0-only
// A dialog of the app: the message, its detail and the buttons, in the app's look.
(async () => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  document.documentElement.lang = params.get('lang') ?? 'en';
  const d = await window.cenacleDialog.get();
  if (!d) return;
  document.body.dataset.type = d.type ?? 'info';
  $('message').textContent = d.message;
  document.title = d.message;
  if (d.detail) $('detail').textContent = d.detail;
  else $('detail').remove();
  const cancel = d.cancelId ?? 0;
  const first = d.defaultId ?? 0;
  // Read left to right: the other choices first, the default one last.
  const order = d.buttons.map((_, i) => i).filter((i) => i !== first);
  order.push(first);
  let focus;
  for (const i of order) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = d.buttons[i];
    b.className = i === first ? 'primary' : 'secondary';
    b.addEventListener('click', () => window.cenacleDialog.answer(i));
    $('buttons').append(b);
    if (i === first) focus = b;
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      window.cenacleDialog.answer(cancel);
    }
  });
  await document.fonts.ready;
  focus?.focus();
  await window.cenacleDialog.ready(document.querySelector('.box').getBoundingClientRect().height);
})();

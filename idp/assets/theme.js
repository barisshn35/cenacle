// SPDX-License-Identifier: AGPL-3.0-only
// Takes the theme chosen in the app (cenacle_id_theme, set when a sign-in
// starts), otherwise follows the system; density follows the pointer type.
(function () {
  var root = document.documentElement;
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  var coarse = window.matchMedia('(pointer: coarse)');
  function chosen() {
    var m = /(?:^|;\s*)cenacle_id_theme=(light|dark)(?:;|$)/.exec(document.cookie);
    return m ? m[1] : null;
  }
  function apply() {
    root.dataset.theme = chosen() || (dark.matches ? 'dark' : 'light');
    root.dataset.density = coarse.matches ? 'comfortable' : 'compact';
  }
  apply();
  dark.addEventListener('change', apply);
  coarse.addEventListener('change', apply);
})();

// SPDX-License-Identifier: AGPL-3.0-only
// Follows the system theme and pointer type (no stored preference on the ID domain).
(function () {
  var root = document.documentElement;
  var dark = window.matchMedia('(prefers-color-scheme: dark)');
  var coarse = window.matchMedia('(pointer: coarse)');
  function apply() {
    root.dataset.theme = dark.matches ? 'dark' : 'light';
    root.dataset.density = coarse.matches ? 'comfortable' : 'compact';
  }
  apply();
  dark.addEventListener('change', apply);
  coarse.addEventListener('change', apply);
})();

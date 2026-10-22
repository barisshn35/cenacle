// SPDX-License-Identifier: Apache-2.0
// Passkeys on the Cenacle ID pages: shows the passkey controls where the browser
// supports WebAuthn, asks the browser and posts its answer with the form.
// Uses SimpleWebAuthn (browser bundle, MIT) loaded before this script.
(function () {
  var web = window.SimpleWebAuthnBrowser;
  if (!web || !web.browserSupportsWebAuthn()) return;
  document.querySelectorAll('[data-passkey-block]').forEach(function (block) {
    block.hidden = false;
  });
  document.querySelectorAll('[data-passkey]').forEach(function (button) {
    var form = button.form;
    var status = document.getElementById(button.dataset.status);
    button.addEventListener('click', async function () {
      if (!form.reportValidity()) return;
      button.disabled = true;
      status.textContent = '';
      try {
        var res = await fetch(button.dataset.options, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
          credentials: 'same-origin',
        });
        if (!res.ok) throw new Error('options ' + res.status);
        var data = await res.json();
        var answer =
          button.dataset.passkey === 'register'
            ? await web.startRegistration({ optionsJSON: data.options })
            : await web.startAuthentication({ optionsJSON: data.options });
        form.elements.challenge.value = data.challengeId;
        form.elements.response.value = JSON.stringify(answer);
        form.submit();
      } catch (err) {
        button.disabled = false;
        status.textContent =
          err && err.name === 'NotAllowedError' ? status.dataset.cancelled : status.dataset.failed;
      }
    });
  });
})();

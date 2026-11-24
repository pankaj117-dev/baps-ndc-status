/* Unlocks the dashboard. GitHub Pages cannot ask for a password itself, so
 * the JSON lives encrypted in vault/*.bin and is decrypted here. Nothing is
 * fetched until the password works. The password is kept for this tab only. */
(function () {
  "use strict";

  const SESSION = "baps-ndc-gate";
  const ITERATIONS = 150000;
  const form = document.getElementById("gateForm");
  const input = document.getElementById("gatePassword");
  const error = document.getElementById("gateError");

  function showError(text) {
    error.hidden = false;
    error.textContent = text;
  }

  async function deriveKey(password, salt) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
      { name: "PBKDF2", salt: salt, iterations: ITERATIONS, hash: "SHA-256" },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"]
    );
  }

  async function decryptBuf(key, buf) {
    const bytes = new Uint8Array(buf);
    const magic = new TextDecoder().decode(bytes.slice(0, 5));
    if (magic !== "BAPS1") throw new Error("This locked file is not a dashboard vault.");
    const iv = bytes.slice(21, 33);
    const payload = bytes.slice(33);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, payload);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function loadVault(password) {
    const names = ["data", "history", "notes", "qa"];
    const bufs = await Promise.all(
      names.map(async (name) => {
        const res = await fetch("vault/" + name + ".bin", { cache: "no-store" });
        if (!res.ok) throw new Error("Missing vault/" + name + ".bin");
        return res.arrayBuffer();
      })
    );
    const salt = new Uint8Array(bufs[0]).slice(5, 21);
    const key = await deriveKey(password, salt);
    const decoded = [];
    for (const buf of bufs) decoded.push(await decryptBuf(key, buf));
    return decoded;
  }

  function openDashboard(parts) {
    document.body.classList.remove("is-locked");
    const lock = document.getElementById("lockDashboard");
    if (lock && !lock._wired) {
      lock._wired = true;
      lock.addEventListener("click", () => {
        sessionStorage.removeItem(SESSION);
        location.reload();
      });
    }
    if (typeof window.startNDC === "function") window.startNDC(parts[0], parts[1], parts[2]);
    if (typeof window.startQA === "function") window.startQA(parts[3]);
  }

  async function unlock(password) {
    error.hidden = true;
    const parts = await loadVault(password);
    sessionStorage.setItem(SESSION, password);
    openDashboard(parts);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const password = input.value;
    const button = form.querySelector("button");
    button.disabled = true;
    unlock(password)
      .catch(() => {
        sessionStorage.removeItem(SESSION);
        showError("That password is not right.");
        button.disabled = false;
        input.focus();
      });
  });

  const saved = sessionStorage.getItem(SESSION);
  if (saved) {
    unlock(saved).catch(() => {
      sessionStorage.removeItem(SESSION);
      input.focus();
    });
  } else {
    input.focus();
  }
})();

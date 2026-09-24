// Copyright 2026 The SpectraWeaver Authors
// SPDX-License-Identifier: Apache-2.0
// Part of SpectraWeaver: https://github.com/YangXu1990uiuc/spectraweaver

import { el } from "./dom.ts";

interface LoginInfo {
  user: string;
  host: string;
  passwordSet: boolean;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function isLoggedIn(): Promise<boolean> {
  try {
    return (await fetch("/api/me")).ok;
  } catch {
    return false;
  }
}

async function loginInfo(): Promise<LoginInfo> {
  try {
    return (await (await fetch("/api/login-info")).json()) as LoginInfo;
  } catch {
    return { user: "", host: "", passwordSet: false };
  }
}

/**
 * Signs in: first with a `#token=` from the address bar (the link `spectraweaver up` prints),
 * otherwise with a password or a pasted token. A bookmark of the plain URL is enough once a
 * password is set.
 */
export async function ensureLogin(app: HTMLElement): Promise<void> {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token");
  if (token) {
    // Take the token out of the address bar and history before anything else.
    params.delete("token");
    const rest = params.toString();
    history.replaceState(null, "", `${location.pathname}${location.search}${rest ? `#${rest}` : ""}`);
    await post("/api/login", { token });
  }
  while (!(await isLoggedIn())) await showLoginForm(app, await loginInfo());
}

function showLoginForm(app: HTMLElement, info: LoginInfo): Promise<void> {
  return new Promise((resolve) => {
    let useToken = !info.passwordSet;
    const who = el("p", { class: "who" }, [info.user ? `${info.user} @ ${info.host}` : ""]);
    const username = el("input", {
      name: "username",
      autocomplete: "username",
      readonly: "",
      value: info.user,
      "aria-label": "user",
    });
    const secret = el("input", { type: "password", name: "password" });
    const error = el("p", { class: "error" });
    const hint = el("p", { class: "hint" });
    const toggle = el("button", { type: "button", class: "link-btn" });
    const form = el("form", { class: "login" }, [
      el("h1", {}, ["SpectraWeaver"]),
      who,
      username,
      secret,
      el("button", { type: "submit", class: "primary" }, ["Sign in"]),
      error,
      hint,
      toggle,
    ]);

    const applyMode = () => {
      username.hidden = useToken;
      secret.placeholder = useToken ? "token" : "password";
      secret.autocomplete = useToken ? "off" : "current-password";
      secret.value = "";
      error.textContent = "";
      hint.replaceChildren(
        ...(useToken
          ? [
              "Run ",
              el("code", {}, ["spectraweaver token"]),
              " on the server. To sign in with a password next time, set one with ",
              el("code", {}, ["spectraweaver passwd"]),
              ".",
            ]
          : []),
      );
      toggle.textContent = useToken ? "Use your password" : "Use the token instead";
      toggle.hidden = !info.passwordSet;
      secret.focus();
    };
    toggle.addEventListener("click", () => {
      useToken = !useToken;
      applyMode();
    });

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = secret.value;
      void post("/api/login", useToken ? { token: value.trim() } : { password: value }).then((response) => {
        if (response.ok) {
          form.remove();
          resolve();
        } else if (response.status === 429) {
          const wait = response.headers.get("retry-after") ?? "a few";
          error.textContent = `Too many attempts. Try again in ${wait} seconds.`;
        } else if (response.status === 403) {
          error.textContent = `The server does not accept the address ${location.hostname}. Start it with --allow-host ${location.hostname}.`;
        } else if (response.status === 503) {
          void response.text().then((reason) => (error.textContent = `Sign-in is unavailable: ${reason}.`));
        } else {
          error.textContent = useToken ? "That token is not valid." : "Wrong password.";
        }
      });
    });

    app.replaceChildren(form);
    applyMode();
  });
}

/** Settings dialog: set or change the login password, and sign out. */
export function createSettingsDialog(toast: (message: string) => void): { open(): void; element: HTMLDialogElement } {
  const status = el("p", { class: "hint" });
  const first = el("input", { type: "password", autocomplete: "new-password", placeholder: "new password" });
  const second = el("input", { type: "password", autocomplete: "new-password", placeholder: "repeat it" });
  const error = el("p", { class: "error" });
  const save = el("button", { type: "submit", class: "primary" }, ["Save password"]);
  const logout = el("button", { type: "button" }, ["Sign out"]);
  const close = el("button", { type: "button" }, ["Close"]);
  const form = el("form", {}, [
    el("h2", {}, ["Settings"]),
    el("section", {}, [
      el("h3", {}, ["Sign-in password"]),
      status,
      el("div", { class: "field" }, [first, second]),
      error,
      save,
    ]),
    el("div", { class: "actions" }, [logout, el("span", { class: "spacer" }), close]),
  ]);
  const dialog = el("dialog", { class: "settings" }, [form]);

  close.addEventListener("click", () => dialog.close());
  logout.addEventListener("click", () => {
    void post("/api/logout", {}).then(() => location.reload());
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (first.value !== second.value) {
      error.textContent = "The two entries differ.";
      return;
    }
    void post("/api/password", { password: first.value }).then(async (response) => {
      if (!response.ok) {
        error.textContent = response.status === 400 ? `Not saved: ${await response.text()}.` : "Not saved.";
        return;
      }
      dialog.close();
      toast("Password saved. Other browsers need to sign in again.");
    });
  });

  return {
    element: dialog,
    open() {
      first.value = "";
      second.value = "";
      error.textContent = "";
      status.textContent = "";
      void loginInfo().then((info) => {
        status.textContent = info.passwordSet
          ? `Signed in as ${info.user} @ ${info.host}. A password is set; saving a new one signs out other browsers.`
          : `Signed in as ${info.user} @ ${info.host}. No password yet: set one to sign in from a bookmark.`;
      });
      dialog.showModal();
      first.focus();
    },
  };
}

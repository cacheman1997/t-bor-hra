const els = {
  teamMenu: document.getElementById("teamMenu"),
  passwordInput: document.getElementById("passwordInput"),
  doLoginBtn: document.getElementById("doLoginBtn"),
  loginStatus: document.getElementById("loginStatus")
};

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const state = {
  teams: [],
  selected: null
};

function startRealTimeClock() {
  const el = document.getElementById("realTimeClock");
  if (!el) return;
  const fmt = new Intl.DateTimeFormat("cs-CZ", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const tick = () => {
    el.textContent = fmt.format(new Date());
    const delay = 1000 - (Date.now() % 1000);
    window.setTimeout(tick, delay);
  };
  tick();
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function setStatus(text) {
  els.loginStatus.textContent = text ?? "";
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error ?? `Chyba ${res.status}`);
  return data;
}

function selectItem(item) {
  state.selected = item;
  for (const el of els.teamMenu.querySelectorAll(".teamBtn")) {
    el.classList.toggle("selected", el.dataset.key === item.key);
  }
  els.passwordInput.focus();
}

function renderMenu() {
  els.teamMenu.innerHTML = "";

  const items = [
    ...state.teams.map((t) => ({
      key: `team:${t.id}`,
      kind: "team",
      id: t.id,
      name: t.name,
      color: t.color
    })),
    { key: "admin", kind: "admin", name: "Admin", color: "#ffffff" }
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "teamBtn";
    btn.dataset.key = item.key;
    btn.innerHTML = `
      <div>
        <div class="teamBtnTitle">${escapeHtml(item.kind === "admin" ? "Admin" : `Tým ${item.name}`)}</div>
        <div class="teamBtnMeta">${escapeHtml(item.kind === "admin" ? "Správa hry" : "Hráčský účet")}</div>
      </div>
      <span class="dot" style="background:${escapeHtml(item.color)}"></span>
    `;
    btn.addEventListener("click", () => selectItem(item));
    els.teamMenu.appendChild(btn);
  }

  if (!state.selected) selectItem(items[0]);
}

async function loadTeams() {
  const res = await fetch("/api/state");
  const data = await res.json();
  state.teams = data?.teams ?? [];
  renderMenu();
}

async function doLogin() {
  const pin = els.passwordInput.value ?? "";
  if (!state.selected) return;

  try {
    setStatus("Přihlašuji…");
    if (state.selected.kind === "admin") {
      const data = await apiPost("/api/admin/login", { pin });
      try {
        if (storage) {
          storage.setItem("token", data.token);
          storage.setItem("role", "admin");
          storage.removeItem("me");
        }
      } catch {
      }
      window.location.href = `/map.html?token=${encodeURIComponent(data.token)}&role=admin`;
      return;
    }

    const data = await apiPost("/api/login", { teamId: state.selected.id, pin });
    try {
      if (storage) {
        storage.setItem("token", data.token);
        storage.setItem("role", "team");
        storage.setItem("me", JSON.stringify(data.team));
      }
    } catch {
    }
    window.location.href = `/map.html?token=${encodeURIComponent(data.token)}&role=team&teamId=${encodeURIComponent(
      data.team?.id ?? ""
    )}&teamName=${encodeURIComponent(data.team?.name ?? "")}&teamColor=${encodeURIComponent(data.team?.color ?? "")}`;
  } catch (e) {
    setStatus(e?.message ?? "Nepodařilo se přihlásit.");
  }
}

els.doLoginBtn.addEventListener("click", doLogin);
els.passwordInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doLogin();
});

startRealTimeClock();
loadTeams().catch(() => setStatus("Chyba načtení týmů."));

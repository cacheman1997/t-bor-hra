const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

const state = {
  token: storage?.getItem("token") || null,
  role: storage?.getItem("role") || null,
  me: (() => {
    try {
      const raw = storage?.getItem("me");
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })(),
  data: null,
  gpsOkByTerritoryId: new Map(),
  eventSource: null,
  streamReconnectTimer: null,
  streamRetryMs: 750,
  streamFailCount: 0,
  pollTimer: null,
  pollRetryMs: 1000,
  pollFailureCount: 0,
  activeModalKind: null,
  lastPendingClaimVerifyRequestIds: new Set(),
  claimVerifyNotifyInitialized: false,
  lastPendingClaimRequestIds: new Set(),
  claimNotifyInitialized: false,
  lastSeenClaimVerifyResolvedAtMs: 0,
  lastCooldownUntilMs: null,
  territorySig: null,
  activeTerritoryModalId: null,
  activeTerritoryModalInfo: null,
  notificationQueue: []
};

const soundManager = {
  ctx: null,
  init() {
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (Ctor) {
        try {
          this.ctx = new Ctor();
        } catch (e) {
          console.error("AudioContext failed", e);
        }
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
  },
  playPing() {
    try {
      this.init();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, this.ctx.currentTime);
      gain.gain.setValueAtTime(0.1, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.5);
      osc.start();
      osc.stop(this.ctx.currentTime + 0.5);
    } catch (e) {
      console.error("playPing failed", e);
    }
  },
  playFanfare() {
    try {
      this.init();
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const notes = [392.00, 523.25, 659.25, 783.99, 523.25, 783.99]; // G C E G C G
      const durations = [0.15, 0.15, 0.15, 0.4, 0.15, 0.6];
      let t = now;
      notes.forEach((freq, i) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.type = "triangle";
        osc.frequency.value = freq;
        const d = durations[i];
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.15, t + 0.02);
        gain.gain.setValueAtTime(0.15, t + d - 0.02);
        gain.gain.linearRampToValueAtTime(0, t + d);
        osc.start(t);
        osc.stop(t + d);
        t += d;
      });
    } catch (e) {
      console.error("playFanfare failed", e);
    }
  }
};

const consoleError = console.error;
console.error = function (...args) {
  if (
    typeof args[0] === "string" &&
    (args[0].includes("ERR_BLOCKED_BY_ORB") || args[0].includes("net::ERR_ABORTED"))
  ) {
    // Suppress specific WMS/network errors from console
    return;
  }
  consoleError.apply(console, args);
};

document.addEventListener("click", () => soundManager.init(), { once: true });
document.addEventListener("touchstart", () => soundManager.init(), { once: true });

const els = {
  logoutBtn: document.getElementById("logoutBtn"),
  loginStatus: document.getElementById("loginStatus"),
  leaderboard: document.getElementById("leaderboard"),
  statusBox: document.getElementById("statusBox"),
  eventLogRows: document.getElementById("eventLogRows"),
  adminPanel: document.getElementById("adminPanel"),
  adminBattles: document.getElementById("adminBattles"),
  modalOverlay: document.getElementById("modalOverlay"),
  modalTitle: document.getElementById("modalTitle"),
  modalBody: document.getElementById("modalBody"),
  modalActions: document.getElementById("modalActions"),
  modalClose: document.getElementById("modalClose")
};

function nowMs() {
  return Date.now();
}

function formatCountdown(ms) {
  if (ms <= 0) return "00:00";
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m.toString().padStart(2, "0")}:${rs.toString().padStart(2, "0")}`;
}

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
    renderLeaderboard();
    const delay = 1000 - (Date.now() % 1000);
    window.setTimeout(tick, delay);
  };
  tick();
}

(() => {
  const qs = new URLSearchParams(window.location.search || "");
  const token = qs.get("token");
  const role = qs.get("role");
  const teamId = qs.get("teamId");
  const teamName = qs.get("teamName");
  const teamColor = qs.get("teamColor");

  if (token && !state.token) state.token = token;
  if (role && !state.role) state.role = role;
  if (state.role === "team" && !state.me && (teamId || teamName || teamColor)) {
    state.me = { id: teamId || "", name: teamName || "", color: teamColor || "" };
  }

  if (token || role || teamId || teamName || teamColor) {
    try {
      if (storage) {
        if (state.token) storage.setItem("token", state.token);
        if (state.role) storage.setItem("role", state.role);
        if (state.role === "team" && state.me) storage.setItem("me", JSON.stringify(state.me));
        if (state.role === "admin") storage.removeItem("me");
      }
    } catch {
    }
    try {
      window.history.replaceState({}, "", "/map.html");
    } catch {
    }
  }
})();

if (!state.role && state.me) state.role = "team";
if (state.role === "admin") state.me = null;
startRealTimeClock();

let map = null;
let territoryLayerById = new Map();
let territoryNumberMarkerById = new Map();

function setStatus(text) {
  els.statusBox.textContent = text;
}

function showLoginStatus(text, kind = "muted") {
  els.loginStatus.className = kind === "muted" ? "muted" : "";
  els.loginStatus.textContent = text;
}

function renderEventLog() {
  if (!els.eventLogRows) return;
  const events = Array.isArray(state.data?.eventLog) ? state.data.eventLog : [];
  els.eventLogRows.innerHTML = "";
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "Zatím žádný záznam.";
    els.eventLogRows.appendChild(empty);
    return;
  }

  const fmt = new Intl.DateTimeFormat("cs-CZ", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });

  for (const ev of events) {
    const row = document.createElement("div");
    row.className = "eventLogRow";
    const ts = Number(ev?.tsMs ?? 0);
    const timeText = Number.isFinite(ts) && ts > 0 ? fmt.format(new Date(ts)) : "--:--:--";
    const d = describeEvent(ev);
    row.innerHTML = `
      <div class="eventLogTime">${escapeHtml(timeText)}</div>
      <div class="eventLogCell">${escapeHtml(d.action)}</div>
      <div class="eventLogCell">${escapeHtml(d.territory)}</div>
      <div class="eventLogText">${escapeHtml(d.teams)}</div>
      <div class="eventLogCell">${escapeHtml(d.result)}</div>
    `;
    els.eventLogRows.appendChild(row);
  }
}

function describeEvent(ev) {
  const viewerTeamId = state.role === "team" ? String(state.me?.id ?? "") : "";
  const kind = String(ev?.kind ?? "");
  const z = territoryById(String(ev?.territoryId ?? ""));
  const tn = z ? territoryNumberText(z) : String(ev?.territoryId ?? "");

  if (kind === "claim") {
    const team = teamById(ev?.teamId);
    const result = String(ev?.result ?? "");
    const action = result === "approved" ? "Záběr" : result === "rejected" ? "Záběr" : "Záběr";
    const teams = team?.name ?? String(ev?.teamId ?? "");
    const resText = result === "approved" ? "OK" : result === "rejected" ? "Zamítnuto" : "";
    return { action, territory: tn, teams, result: resText };
  }

  if (kind === "owner_set") {
    const from = teamById(ev?.fromTeamId);
    const to = teamById(ev?.toTeamId);
    const fromName = ev?.fromTeamId ? from?.name ?? ev?.fromTeamId : "nikdo";
    const toName = ev?.toTeamId ? to?.name ?? ev?.toTeamId : "nikdo";
    return { action: "Admin", territory: tn, teams: `${fromName} → ${toName}`, result: "" };
  }

  return { action: "Událost", territory: tn, teams: "", result: "" };
}

function openModal({ title, bodyHtml, actions, kind = null }) {
  state.activeModalKind = kind;
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = bodyHtml;
  els.modalActions.innerHTML = "";
  for (const a of actions ?? []) {
    const btn = document.createElement("button");
    btn.className = `btn ${a.kind ?? ""}`.trim();
    btn.textContent = a.label;
    btn.addEventListener("click", a.onClick);
    els.modalActions.appendChild(btn);
  }
  els.modalOverlay.classList.remove("hidden");
}

function processNotificationQueue() {
  if (state.notificationQueue.length === 0) return;
  if (!els.modalOverlay.classList.contains("hidden")) return;
  const item = state.notificationQueue.shift();
  openModal(item);
}

function closeModal() {
  els.modalOverlay.classList.add("hidden");
  state.activeModalKind = null;
  state.activeTerritoryModalId = null;
  state.activeTerritoryModalInfo = null;
  setTimeout(processNotificationQueue, 200);
}

els.modalClose.addEventListener("click", closeModal);
els.modalOverlay.addEventListener("click", (e) => {
  if (e.target === els.modalOverlay) closeModal();
});

function teamById(teamId) {
  return state.data?.teams?.find((t) => t.id === teamId) ?? null;
}

function territoryById(id) {
  return state.data?.territories?.find((t) => t.id === id) ?? null;
}

function renderLeaderboard() {
  if (!state.data || !els.leaderboard) return;
  const teams = state.data.teams || [];
  const territories = state.data.territories || [];
  const stats = state.data.teamStats || {};
  const tnow = Date.now();

  const teamData = teams.map((t) => {
    const s = stats[t.id] || {};
    let totalTime = Number(s.totalTimeMs || 0);

    // Add time for currently held territories
    territories.forEach((z) => {
      if (z.ownerTeamId === t.id) {
        const cap = Number(z.capturedAtMs);
        if (Number.isFinite(cap) && cap > 0) {
          const duration = Math.max(0, tnow - cap);
          totalTime += duration;
        }
      }
    });

    return {
      id: t.id,
      name: t.name,
      color: t.color,
      captures: Number(s.captures || 0),
      totalTimeMs: totalTime
    };
  });

  // 1. Rank by Captures
  teamData.sort((a, b) => b.captures - a.captures);
  teamData.forEach((d, i) => (d.rankCaptures = i + 1));
  const listCaptures = [...teamData];

  // 2. Rank by Time
  teamData.sort((a, b) => b.totalTimeMs - a.totalTimeMs);
  teamData.forEach((d, i) => (d.rankTime = i + 1));
  const listTime = [...teamData];

  // 3. Average Rank
  teamData.forEach((d) => {
    d.avgRank = (d.rankCaptures + d.rankTime) / 2;
  });

  // 4. Final Sort by Average Rank
  teamData.sort((a, b) => a.avgRank - b.avgRank || b.captures - a.captures);
  const listFinal = [...teamData];

  els.leaderboard.innerHTML = "";

  if (!teamData.length) {
    els.leaderboard.innerHTML = '<div class="muted">Žádné týmy.</div>';
    return;
  }

  const createSection = (title, list, type) => {
    const container = document.createElement("div");
    container.style.marginBottom = "20px";
    
    const titleEl = document.createElement("div");
    titleEl.className = "panelTitle";
    titleEl.style.fontSize = "0.95em";
    titleEl.style.marginBottom = "4px";
    titleEl.textContent = title;
    container.appendChild(titleEl);

    // Header
    const header = document.createElement("div");
    header.className = "scoreRow muted";
    header.style.fontSize = "0.85em";
    
    let col3 = "";
    if (type === "captures") col3 = `<div style="width:40px;text-align:right">Záb</div>`;
    else if (type === "time") col3 = `<div style="width:70px;text-align:right">Čas</div>`;
    else col3 = `<div style="width:40px;text-align:right">Ø</div>`;

    header.innerHTML = `
      <div style="width:20px">#</div>
      <div style="flex:1">Tým</div>
      ${col3}
    `;
    container.appendChild(header);

    list.forEach((d, i) => {
      const row = document.createElement("div");
      row.className = "scoreRow";
      
      let valHtml = "";
      if (type === "captures") {
         valHtml = `<div class="scoreCount" style="width:40px;text-align:right">${d.captures}</div>`;
      } else if (type === "time") {
         const seconds = Math.floor(d.totalTimeMs / 1000);
         const h = Math.floor(seconds / 3600);
         const m = Math.floor((seconds % 3600) / 60);
         const s = seconds % 60;
         const timeStr = `${h}h${m.toString().padStart(2,"0")}m${s.toString().padStart(2,"0")}s`;
         valHtml = `<div class="scoreCount" style="width:70px;text-align:right;font-size:0.85em;white-space:nowrap">${timeStr}</div>`;
      } else {
         valHtml = `<div class="scoreCount" style="width:40px;text-align:right">${d.avgRank.toFixed(1)}</div>`;
      }

      row.innerHTML = `
        <div class="scoreRank" style="width:20px">${i + 1}.</div>
        <div class="scoreName"><span class="dot" style="background:${d.color}"></span> ${escapeHtml(d.name)}</div>
        ${valHtml}
      `;
      container.appendChild(row);
    });

    els.leaderboard.appendChild(container);
  };

  createSection("1. Počet území", listCaptures, "captures");
  createSection("2. Čas držení", listTime, "time");
  createSection("3. Finální pořadí", listFinal, "final");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function territoryNumberText(z) {
  const m = String(z?.id ?? "").match(/\d+/g);
  if (m && m.length) return m.join("");
  const m2 = String(z?.name ?? "").match(/\d+/g);
  if (m2 && m2.length) return m2.join("");
  return String(z?.id ?? "");
}

function pointInPolygon(point, polygon) {
  const x = Number(point[1]);
  const y = Number(point[0]);
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i][1]);
    const yi = Number(polygon[i][0]);
    const xj = Number(polygon[j][1]);
    const yj = Number(polygon[j][0]);
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-30) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function polygonCentroid(polygon) {
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i][1]);
    const yi = Number(polygon[i][0]);
    const xj = Number(polygon[j][1]);
    const yj = Number(polygon[j][0]);
    const cross = xj * yi - xi * yj;
    area2 += cross;
    cx += (xj + xi) * cross;
    cy += (yj + yi) * cross;
  }
  if (Math.abs(area2) < 1e-9) {
    let sx = 0;
    let sy = 0;
    for (const p of polygon) {
      sy += Number(p[0]);
      sx += Number(p[1]);
    }
    const n = Math.max(1, polygon.length);
    return [sy / n, sx / n];
  }
  const k = 1 / (3 * area2);
  return [cy * k, cx * k];
}

function distPointToSegmentSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const apx = px - ax;
  const apy = py - ay;
  const abLen2 = abx * abx + aby * aby;
  let t = abLen2 <= 1e-30 ? 0 : (apx * abx + apy * aby) / abLen2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * abx;
  const qy = ay + t * aby;
  const dx = px - qx;
  const dy = py - qy;
  return dx * dx + dy * dy;
}

function minDistToEdgesSq(point, polygon) {
  const px = Number(point[1]);
  const py = Number(point[0]);
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = Number(polygon[j][1]);
    const ay = Number(polygon[j][0]);
    const bx = Number(polygon[i][1]);
    const by = Number(polygon[i][0]);
    const d2 = distPointToSegmentSq(px, py, ax, ay, bx, by);
    if (d2 < best) best = d2;
  }
  return best;
}

function labelPointInside(polygon, seedKey) {
  if (!Array.isArray(polygon) || polygon.length < 3) return null;
  
  // Helper to score a point
  // Returns > 0 (squared dist) if inside, -1 if outside
  function getScore(pt) {
    if (!pointInPolygon(pt, polygon)) return -1;
    return minDistToEdgesSq(pt, polygon);
  }

  const c = polygonCentroid(polygon);
  let bestPt = c;
  let bestScore = getScore(c);

  let minLat = Infinity, minLng = Infinity, maxLat = -Infinity, maxLng = -Infinity;
  for (const p of polygon) {
    const lat = Number(p[0]);
    const lng = Number(p[1]);
    if (lat < minLat) minLat = lat;
    if (lng < minLng) minLng = lng;
    if (lat > maxLat) maxLat = lat;
    if (lng > maxLng) maxLng = lng;
  }

  if (!Number.isFinite(minLat)) return c;

  // deterministic RNG
  let s = 0;
  for (const ch of String(seedKey ?? "")) s = (s * 31 + ch.charCodeAt(0)) >>> 0;
  function rnd() {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  }

  // 1. Grid Search (Coarse)
  // 15x15 grid covers most shapes well
  const steps = 15;
  const stepLat = (maxLat - minLat) / steps;
  const stepLng = (maxLng - minLng) / steps;

  for (let i = 1; i < steps; i++) {
    for (let j = 1; j < steps; j++) {
      const lat = minLat + i * stepLat;
      const lng = minLng + j * stepLng;
      const pt = [lat, lng];
      const score = getScore(pt);
      if (score > bestScore) {
        bestScore = score;
        bestPt = pt;
      }
    }
  }

  // 2. Random fallback if grid failed (e.g. very thin diagonal polygon)
  if (bestScore <= 0) {
      const tries = 500;
      for(let k=0; k<tries; k++) {
         const lat = minLat + rnd() * (maxLat - minLat);
         const lng = minLng + rnd() * (maxLng - minLng);
         const pt = [lat, lng];
         const score = getScore(pt);
         if (score > bestScore) {
             bestScore = score;
             bestPt = pt;
         }
      }
  }

  // 3. Iterative Refinement (Hill Climbing)
  // If we have a valid point, try to improve it by searching neighborhood
  if (bestScore > 0) {
      let currStepLat = (maxLat - minLat) / 10;
      let currStepLng = (maxLng - minLng) / 10;
      
      // 3 passes of refinement
      for (let pass = 0; pass < 3; pass++) {
        const startLat = bestPt[0] - currStepLat;
        const startLng = bestPt[1] - currStepLng;
        // Search 5x5 grid around best point
        const subStepLat = (currStepLat * 2) / 5;
        const subStepLng = (currStepLng * 2) / 5;
        
        for (let i = 0; i <= 5; i++) {
            for (let j = 0; j <= 5; j++) {
                const lat = startLat + i * subStepLat;
                const lng = startLng + j * subStepLng;
                const pt = [lat, lng];
                const score = getScore(pt);
                if (score > bestScore) {
                    bestScore = score;
                    bestPt = pt;
                }
            }
        }
        // Shrink search area for next pass
        currStepLat = subStepLat;
        currStepLng = subStepLng;
      }
  }

  return bestPt;
}

function setAdminPanelVisible(visible) {
  if (!els.adminPanel) return;
  els.adminPanel.style.display = visible ? "" : "none";
}

function renderAdminBattles() {
  if (!els.adminBattles) return;
  if (state.role !== "admin") {
    els.adminBattles.innerHTML = "";
    setAdminPanelVisible(false);
    return;
  }
  setAdminPanelVisible(true);

  const claimVerifyRequests = Array.isArray(state.data?.claimVerifyRequests)
    ? state.data.claimVerifyRequests
    : [];
  // Include pending AND approved (waiting for task assignment)
  const pendingClaimVerify = claimVerifyRequests
    .filter((r) => r && typeof r === "object" && ["pending", "approved"].includes(r.status ?? "pending"))
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));

  const nextPendingVerifyIds = new Set(pendingClaimVerify.map((r) => String(r.id ?? "")));
  const addedPendingVerify = [];
  if (state.claimVerifyNotifyInitialized) {
    for (const id of nextPendingVerifyIds) {
      if (id && !state.lastPendingClaimVerifyRequestIds.has(id)) addedPendingVerify.push(id);
    }
  } else {
    state.claimVerifyNotifyInitialized = true;
  }
  state.lastPendingClaimVerifyRequestIds = nextPendingVerifyIds;

  const claimRequests = Array.isArray(state.data?.claimRequests) ? state.data.claimRequests : [];
  const pendingClaims = claimRequests
    .filter((r) => r && typeof r === "object" && (r.status ?? "pending") === "pending")
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));

  const nextPendingIds = new Set(pendingClaims.map((r) => String(r.id ?? "")));
  const addedPending = [];
  if (state.claimNotifyInitialized) {
    for (const id of nextPendingIds) {
      if (id && !state.lastPendingClaimRequestIds.has(id)) addedPending.push(id);
    }
  } else {
    state.claimNotifyInitialized = true;
  }
  state.lastPendingClaimRequestIds = nextPendingIds;

  // REPLACED_BLOCK_START
  if (addedPendingVerify.length > 0) {
    soundManager.playPing();
    for (const id of addedPendingVerify) {
      const r = pendingClaimVerify.find((x) => String(x.id ?? "") === String(id));
      if (!r) continue;
      const t = teamById(r.teamId);
      const z = territoryById(r.territoryId);
      const tn = z ? territoryNumberText(z) : String(r.territoryId ?? "");
      const isApproved = r.status === "approved";
      
      const body = `
        <div class="muted" style="margin-top:6px">
            <span class="dot" style="background:${escapeHtml(t?.color ?? "rgba(255,255,255,0.25)")}"></span> 
            ${escapeHtml(t?.name ?? r.teamId)} → území ${escapeHtml(tn)}
            ${isApproved ? "<br><b>Čeká na zadání úkolu</b>" : ""}
        </div>
      `;
      
      state.notificationQueue.push({
        title: isApproved ? "Zadání úkolu" : "Žádost o ověření polohy",
        bodyHtml: body,
        actions: [
          { label: "Zavřít", onClick: closeModal },
          {
            label: isApproved ? "Zadat úkol" : "Vyřídit",
            kind: "primary",
            onClick: () => {
              if (isApproved) {
                  openAssignTaskModal(String(r.id));
              } else {
                  openClaimVerifyRequestAdminModal(String(r.id));
              }
            }
          }
        ]
      });
    }
  }
  if (addedPending.length > 0) {
    soundManager.playPing();
    for (const id of addedPending) {
      const r = pendingClaims.find((x) => String(x.id ?? "") === String(id));
      if (!r) continue;
      const t = teamById(r.teamId);
      const z = territoryById(r.territoryId);
      const tn = z ? territoryNumberText(z) : String(r.territoryId ?? "");
      const body = `<div class="muted" style="margin-top:6px"><span class="dot" style="background:${escapeHtml(t?.color ?? "rgba(255,255,255,0.25)")}"></span> ${escapeHtml(t?.name ?? r.teamId)} → území ${escapeHtml(tn)}</div>`;
      
      state.notificationQueue.push({
        title: "Nová žádost o obsazení",
        bodyHtml: body,
        actions: [
          { label: "Zavřít", onClick: closeModal },
          {
            label: "Vyřídit",
            kind: "primary",
            onClick: () => {
              openClaimRequestAdminModal(String(r.id));
            }
          }
        ]
      });
    }
  }

  processNotificationQueue();

  els.adminBattles.innerHTML = "";

  const adminActions = document.createElement("div");
  adminActions.style.display = "flex";
  adminActions.style.gap = "10px";
  adminActions.style.justifyContent = "flex-end";
  adminActions.style.marginBottom = "10px";
  const locked = Boolean(state.data?.config?.gameLocked);
  
  if (locked) {
    adminActions.innerHTML = `
      <div class="hint" style="margin-right:auto;align-self:center">Hra ukončena.</div>
      <button class="btn danger" data-action="start">NOVÁ HRA</button>
    `;
  } else {
    adminActions.innerHTML = `
      <button class="btn danger" data-action="start">RESTART</button>
      <button class="btn danger" data-action="lock">KONEC</button>
    `;
  }

  adminActions.querySelector('[data-action="start"]')?.addEventListener("click", () => {
    openModal({
      title: locked ? "Nová hra" : "Restart",
      bodyHtml: "Opravdu chceš spustit novou hru? Vyresetuje všechna území a všechny timery.",
      actions: [
        { label: "Zavřít", onClick: closeModal },
        {
          label: "START",
          kind: "danger",
          onClick: () => {
            apiPost("/api/admin/territories/reset", { token: state.token })
              .then(() => {
                closeModal();
                forceRefresh();
              })
              .catch((e) => {
                openModal({
                  title: "Chyba",
                  bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
                  actions: [{ label: "OK", onClick: closeModal }]
                });
              });
          }
        }
      ]
    });
  });
  adminActions.querySelector('[data-action="lock"]')?.addEventListener("click", () => {
    openModal({
      title: "Konec hry",
      bodyHtml: "Opravdu chceš ukončit hru? Zablokuje jakékoliv změny a zastaví časomíru.",
      actions: [
        { label: "Zavřít", onClick: closeModal },
        {
          label: "KONEC",
          kind: "danger",
          onClick: () => {
            apiPost("/api/admin/game/setLocked", { token: state.token, locked: true })
              .then(() => {
                closeModal();
                forceRefresh();
              })
              .catch((e) => {
                openModal({
                  title: "Chyba",
                  bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
                  actions: [{ label: "OK", onClick: closeModal }]
                });
              });
          }
        }
      ]
    });
  });
  els.adminBattles.appendChild(adminActions);

  const requestsTitle = document.createElement("div");
  requestsTitle.className = "muted";
  requestsTitle.style.marginTop = "12px";
  requestsTitle.textContent = "Požadavky";
  els.adminBattles.appendChild(requestsTitle);

  const items = [];

  for (const r of pendingClaimVerify) {
    items.push({
      kind: "claimVerify",
      id: String(r.id ?? ""),
      timeMs: Number(r.createdAtMs ?? 0),
      payload: r
    });
  }
  for (const r of pendingClaims) {
    items.push({
      kind: "claim",
      id: String(r.id ?? ""),
      timeMs: Number(r.createdAtMs ?? 0),
      payload: r
    });
  }

  items.sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0));

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.style.marginTop = "6px";
    empty.textContent = "Žádné čekající požadavky.";
    els.adminBattles.appendChild(empty);
  } else {
    for (const it of items) {
      if (it.kind === "claimVerify") {
        const r = it.payload;
        const team = teamById(r.teamId);
        const z = territoryById(r.territoryId);
        const status = r.status ?? "pending";
        const isApproved = status === "approved";
        
        const row = document.createElement("div");
        row.className = "battleRow";
        row.innerHTML = `
          <div class="battleRowTop">
            <div class="battleRowTitle">
                ${isApproved ? "Zadání úkolu" : "Ověření polohy"} – území ${escapeHtml(z ? territoryNumberText(z) : String(r.territoryId ?? ""))}
            </div>
            <div class="battleRowMeta">${escapeHtml(String(r.id ?? ""))}</div>
          </div>
          <div class="muted">
            <span class="dot" style="background:${escapeHtml(team?.color ?? "rgba(255,255,255,0.25)")}"></span>
            ${escapeHtml(team?.name ?? r.teamId)}
            ${isApproved ? " <span class='pill'>Čeká na úkol</span>" : ""}
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button class="btn primary">${isApproved ? "Zadat úkol" : "Vyřídit"}</button>
          </div>
        `;
        row.querySelector("button")?.addEventListener("click", () => {
            if (isApproved) {
                openAssignTaskModal(String(r.id ?? ""));
            } else {
                openClaimVerifyRequestAdminModal(String(r.id ?? ""));
            }
        });
        els.adminBattles.appendChild(row);
      } else if (it.kind === "claim") {
        const r = it.payload;
        const team = teamById(r.teamId);
        const z = territoryById(r.territoryId);
        const answer = String(r.answer ?? "");
        const row = document.createElement("div");
        row.className = "battleRow";
        row.innerHTML = `
          <div class="battleRowTop">
            <div class="battleRowTitle">Žádost o obsazení – území ${escapeHtml(z ? territoryNumberText(z) : String(r.territoryId ?? ""))}</div>
            <div class="battleRowMeta">${escapeHtml(String(r.id ?? ""))}</div>
          </div>
          <div class="muted">
            <span class="dot" style="background:${escapeHtml(team?.color ?? "rgba(255,255,255,0.25)")}"></span>
            ${escapeHtml(team?.name ?? r.teamId)}${answer ? ` · odpověď: ${escapeHtml(answer)}` : ""}
          </div>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button class="btn primary">Vyřídit</button>
          </div>
        `;
        row.querySelector("button")?.addEventListener("click", () => openClaimRequestAdminModal(String(r.id ?? "")));
        els.adminBattles.appendChild(row);
      }
    }
  }
}

async function openClaimVerifyRequestAdminModal(claimVerifyRequestId) {
  const req = (state.data?.claimVerifyRequests ?? []).find(
    (r) => String(r?.id ?? "") === String(claimVerifyRequestId)
  );
  if (!req) {
    openModal({
      title: "Žádost nenalezena",
      bodyHtml: `<div class="muted">Žádost už nejspíš byla vyřízena.</div>`,
      actions: [{ label: "OK", onClick: closeModal }]
    });
    return;
  }

  const team = teamById(req.teamId);
  const z = territoryById(req.territoryId);
  const tn = z ? territoryNumberText(z) : String(req.territoryId ?? "");
  const lat = req.lat;
  const lng = req.lng;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);

  const body = `
    <div style="margin-bottom:10px">
      <span class="pill"><span class="dot" style="background:${escapeHtml(team?.color ?? "rgba(255,255,255,0.25)")}"></span>${escapeHtml(team?.name ?? req.teamId)}</span>
      <span class="pill" style="margin-left:8px">Území ${escapeHtml(tn)}</span>
    </div>
    <div class="hint">Ověř polohu týmu na mapě.</div>
    <div id="verifyMap" style="width:100%;height:300px;background:#eee;margin-top:10px;border-radius:4px;"></div>
  `;

  openModal({
    title: "Admin – Ověření polohy",
    bodyHtml: body,
    actions: [
      { label: "Zavřít", onClick: closeModal },
      {
        label: "OK",
        kind: "primary",
        onClick: () => {
          apiPost("/api/admin/claimVerifyRequest/resolve", {
            token: state.token,
            claimVerifyRequestId,
            ok: true
          })
            .then(() => {
              // Instead of closing, go to task assignment
              openAssignTaskModal(claimVerifyRequestId);
            })
            .catch((e) => {
              openModal({
                title: "Chyba",
                bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
                actions: [{ label: "OK", onClick: closeModal }]
              });
            });
        }
      }
    ]
  });

  // Init Mini Map
  setTimeout(() => {
     if(!document.getElementById("verifyMap")) return;
     try {
         const center = hasCoords ? [lat, lng] : (z ? polygonCentroid(z.polygon) : [50, 15]);
         const mm = L.map("verifyMap").setView(center, 15);
         L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: '© OpenStreetMap',
            maxZoom: 19
         }).addTo(mm);
         
         if (z && z.polygon) {
             L.polygon(z.polygon, { color: "red", fillOpacity: 0.1, weight: 2 }).addTo(mm);
         }
         
         if (hasCoords) {
             L.circleMarker([lat, lng], {
                color: '#fff',
                weight: 2,
                fillColor: team?.color ?? 'red',
                fillOpacity: 1,
                radius: 8
             }).addTo(mm).bindPopup(team?.name ?? "Tým").openPopup();
         }
     } catch(e) {
         console.error(e);
     }
  }, 100);
}

function openAssignTaskModal(claimVerifyRequestId) {
    const dummyTasks = state.data?.dummyTasks || [];
    // If empty (legacy state?), fallback to hardcoded list
    const fallbackTasks = [
        "Udělejte 10 dřepů a pošlete video/foto.",
        "Zaspívejte týmovou hymnu.",
        "Najděte v okolí červený předmět a vyfoťte ho.",
        "Vytvořte z těl písmeno T.",
        "Odpovězte na hádanku: Co má zuby, ale nekouše?",
        "Udělejte selfie s celým týmem.",
        "Postavte malou pyramidu z kamenů/klacků.",
        "Vyfoťte nejvyšší strom v okolí."
    ];
    const tasksToShow = dummyTasks.length > 0 ? dummyTasks : fallbackTasks;

    const options = tasksToShow.map(t => `<option value="${escapeHtml(t)}">${escapeHtml(t)}</option>`).join("");
    
    const body = `
        <div class="panelTitle">Vyber nebo napiš úkol</div>
        <select id="taskSelect" style="width:100%;margin-bottom:10px;padding:8px">
            <option value="">-- Vyber ze seznamu --</option>
            ${options}
        </select>
        <textarea id="taskCustom" rows="4" style="width:100%;padding:8px" placeholder="Vlastní úkol..."></textarea>
    `;

    openModal({
        title: "Admin – Zadání úkolu",
        bodyHtml: body,
        actions: [
            {
                label: "Odeslat úkol",
                kind: "primary",
                onClick: () => {
                    const sel = document.getElementById("taskSelect");
                    const txt = document.getElementById("taskCustom");
                    let val = txt.value.trim();
                    if (!val && sel.value) val = sel.value;
                    
                    if (!val) {
                        alert("Vyber nebo napiš úkol.");
                        return;
                    }

                    apiPost("/api/admin/claimVerifyRequest/assignTask", {
                        token: state.token,
                        claimVerifyRequestId,
                        task: val
                    })
                    .then(() => {
                        closeModal();
                        forceRefresh();
                    })
                    .catch(e => {
                        alert(e.message);
                    });
                }
            }
        ]
    });
    
    // Auto-fill textarea when select changes
    setTimeout(() => {
        const sel = document.getElementById("taskSelect");
        const txt = document.getElementById("taskCustom");
        if(sel && txt) {
            sel.addEventListener("change", () => {
                if(sel.value) txt.value = sel.value;
            });
        }
    }, 50);
}

async function openClaimRequestAdminModal(claimRequestId) {
  const req = (state.data?.claimRequests ?? []).find((r) => String(r?.id ?? "") === String(claimRequestId));
  if (!req) {
    openModal({
      title: "Žádost nenalezena",
      bodyHtml: `<div class="muted">Žádost už nejspíš byla vyřízena.</div>`,
      actions: [{ label: "OK", onClick: closeModal }]
    });
    return;
  }

  const team = teamById(req.teamId);
  const z = territoryById(req.territoryId);
  const tn = z ? territoryNumberText(z) : String(req.territoryId ?? "");
  const answer = String(req.answer ?? "").trim();
  const question = String(req.question ?? "").trim();
  const body = `
    <div style="margin-bottom:10px">
      <span class="pill"><span class="dot" style="background:${escapeHtml(team?.color ?? "rgba(255,255,255,0.25)")}"></span>${escapeHtml(team?.name ?? req.teamId)}</span>
      <span class="pill" style="margin-left:8px">Území ${escapeHtml(tn)}</span>
    </div>
    <div><div class="panelTitle">Otázka</div><div>${escapeHtml(question || "(bez otázky)")}</div></div>
    <div style="margin-top:10px"><div class="panelTitle">Odpověď</div><div>${escapeHtml(answer || "(bez odpovědi)")}</div></div>
  `;

  openModal({
    title: "Admin – Obsazení území",
    bodyHtml: body,
    actions: [
      { label: "Zavřít", onClick: closeModal },
      {
        label: "Špatně",
        kind: "danger",
        onClick: () => {
          apiPost("/api/admin/claimRequest/resolve", { token: state.token, claimRequestId, correct: false })
            .then(() => {
              closeModal();
              forceRefresh();
            })
            .catch((e) => {
              openModal({
                title: "Chyba",
                bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
                actions: [{ label: "OK", onClick: closeModal }]
              });
            });
        }
      },
      {
        label: "Správně",
        kind: "primary",
        onClick: () => {
          apiPost("/api/admin/claimRequest/resolve", { token: state.token, claimRequestId, correct: true })
            .then(() => {
              closeModal();
              forceRefresh();
            })
            .catch((e) => {
              openModal({
                title: "Chyba",
                bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
                actions: [{ label: "OK", onClick: closeModal }]
              });
            });
        }
      }
    ]
  });
}

function applyTerritoryStyles() {
  for (const z of state.data?.territories ?? []) {
    const layer = territoryLayerById.get(z.id);
    if (!layer) continue;
    const owner = z.ownerTeamId ? teamById(z.ownerTeamId) : null;
    const fillColor = owner?.color ?? "#808080"; // Gray fill if no owner
    
    layer.setStyle({
      color: "#000000", // Always black border
      weight: 3, // Slightly thinner
      opacity: 1, // Always visible
      fillColor,
      fillOpacity: owner ? 0.35 : 0.1 // Very transparent for unowned
    });
  }
}

function updateMapMarkers() {
  if (!map) return;
  // Remove old markers
  for (const m of territoryNumberMarkerById.values()) {
    m.remove();
  }
  territoryNumberMarkerById.clear();

  // Add new markers
  for (const z of state.data?.territories ?? []) {
    const labelPt = labelPointInside(z.polygon, z.id);
    if (labelPt) {
      let html = `<div class="territoryNumber">${escapeHtml(territoryNumberText(z))}</div>`;
      
      const globalLock = state.data?.territoryLocks?.[z.id];
      const teamLock = state.data?.attackLocks?.[z.id];
      
      const isGlobalLocked = globalLock && Number(globalLock) > Date.now();
      const isTeamLocked = state.role === "team" && state.me && teamLock && (teamLock[state.me.id] && Number(teamLock[state.me.id]) > Date.now());
      // Note: attackLocks structure on client:
      // if admin: { territoryId: { teamId: timestamp } } (maybe?) 
      // Actually server sends: "attackLocks": state.get("attackLocks", {}) if role == "admin" else (state.get("attackLocks", {}) or {}).get(team_id, {}) if (role == "team" and team_id) else {},
      // So for TEAM role, attackLocks is just { territoryId: timestamp } directly!
      
      let isTeamLockedForMe = false;
      if (state.role === "team") {
         const lockVal = state.data?.attackLocks?.[z.id];
         isTeamLockedForMe = lockVal && Number(lockVal) > Date.now();
      }

      if (isGlobalLocked || isTeamLockedForMe) {
        // Lock icon
        html = `<div class="territoryNumber" style="background:rgba(0,0,0,0.8);border-color:rgba(255,255,255,0.6)">🔒</div>`;
      }
      const marker = L.marker(labelPt, {
        interactive: false,
        icon: L.divIcon({
          className: "territoryNumberIcon",
          html: html,
          iconSize: [26, 26],
          iconAnchor: [13, 13]
        })
      }).addTo(map);
      territoryNumberMarkerById.set(z.id, marker);
    }
  }
}

function initMap() {
  const config = state.data?.config;
  if (!config) return;
  if (typeof window.L === "undefined") {
    setStatus("Mapa nejde načíst (chybí Leaflet).");
    return;
  }
  if (!document.getElementById("map")) return;

  if (map) {
    map.remove();
    map = null;
    territoryLayerById = new Map();
    territoryNumberMarkerById = new Map();
  }

  if (config.mapMode === "simple") {
    const w = config.simpleMap?.width ?? 1000;
    const h = config.simpleMap?.height ?? 1000;
    const bounds = [
      [0, 0],
      [h, w]
    ];
    map = L.map("map", {
      crs: L.CRS.Simple,
      minZoom: -2,
      maxZoom: 2,
      zoomSnap: 0.25
    });
    map.fitBounds(bounds);
    map.setMaxBounds(bounds);
    const imageUrl = config.simpleMap?.imageUrl;
    if (imageUrl) {
      L.imageOverlay(imageUrl, bounds, { opacity: 1 }).addTo(map);
    }
  } else {
    // Geo Mode (WGS84 / Web Mercator)
    map = L.map("map").setView([50.08, 16.3], 13);
    
    // 1. OpenStreetMap (Fallback / Base)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);

    // 2. WMS Layer from CUZK (ArcGIS / ZTM) - Try to overlay
    // Using AGS service which might be more stable for CORS/ORB
    L.tileLayer.wms("https://ags.cuzk.gov.cz/arcgis1/services/ZTM/ZTM10/MapServer/WMSServer", {
      layers: '0', 
      format: 'image/png',
      transparent: true,
      attribution: "© ČÚZK",
      crs: L.CRS.EPSG3857,
      maxZoom: 20,
      opacity: 0.8 // Slightly transparent to see OSM if it fails or matches
    }).addTo(map);
  }

  // Create a custom pane for territories to ensure they are always on top of tiles
  map.createPane('territories');
  map.getPane('territories').style.zIndex = 600;

  for (const z of state.data?.territories ?? []) {
    const opts = {
      pane: 'territories',
      color: "#000000", // Pure black
      weight: 3, // Slightly thinner
      fillColor: "#808080",
      fillOpacity: 0.1
    };
    
    const layer = L.polygon(z.polygon, opts).addTo(map);
    
    // Store original ID/Text for saving
    layer._originalText = territoryNumberText(z);
    
    layer.bindTooltip(z.name, { sticky: true });
    
    layer.on("click", () => onTerritoryClicked(z.id));
    
    territoryLayerById.set(z.id, layer);
  }

  updateMapMarkers();
  applyTerritoryStyles();
}

async function loadInitialState() {
  const qs = state.token ? `?token=${encodeURIComponent(state.token)}` : "";
  const res = await fetch(`/api/state${qs}`);
  state.data = await res.json();
  state.territorySig = (state.data?.territories ?? []).map((t) => t.id).join("|");
  renderLeaderboard();
  renderAdminBattles();
  renderEventLog();
  initMap();
}

async function forceRefresh() {
  try {
    const qs = state.token ? `?token=${encodeURIComponent(state.token)}` : "";
    const res = await fetch(`/api/state${qs}`);
    if (res.ok) {
      const data = await res.json();
      onStateUpdate(data);
    }
  } catch (e) {
    console.error("Force refresh failed", e);
  }
}

async function apiPost(path, payload) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload ?? {})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error ?? `Chyba ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

function startStream() {
  stopStream();
  stopPolling();
  if (!state.token) return;

  const es = new EventSource(`/api/stream?token=${encodeURIComponent(state.token)}`);
  state.eventSource = es;

  es.addEventListener("open", () => {
    state.streamRetryMs = 750;
    state.streamFailCount = 0;
    setStatus("Online");
  });

  es.addEventListener("state", (evt) => {
    try {
      const data = JSON.parse(evt.data);
      onStateUpdate(data);
    } catch {
      setStatus("Chyba streamu");
    }
  });

  es.addEventListener("error", () => {
    // Only set error status if we are really disconnected for a while
    // setStatus("Odpojeno");
    state.streamFailCount = Number(state.streamFailCount || 0) + 1;
    stopStream();
    if (state.streamFailCount >= 3) {
      startPolling();
      return;
    }
    scheduleStreamReconnect();
  });
}

function scheduleStreamReconnect() {
    setTimeout(startStream, state.streamRetryMs || 1000);
}

function startPolling() {
  stopStream();
  if (!state.token) return;
  if (state.pollTimer) return;
  state.pollFailureCount = 0;
  state.pollRetryMs = 1000;
  setStatus("Offline — režim dotazování");
  pollOnce();
  state.pollTimer = setInterval(pollOnce, 3000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function pollOnce() {
  if (!state.token) return;
  if (document.visibilityState !== "visible") return;
  try {
    const res = await fetch(`/api/state?token=${encodeURIComponent(state.token)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? `Chyba ${res.status}`);
    onStateUpdate(data);

    state.pollFailureCount = 0;
    if (Number(state.streamFailCount || 0) >= 3 && !state.eventSource) {
      startStream();
    }
  } catch {
    state.pollFailureCount = Number(state.pollFailureCount || 0) + 1;
    if (state.pollFailureCount >= 10) {
      state.pollFailureCount = 0;
      state.streamFailCount = 0;
      stopPolling();
      scheduleStreamReconnect();
    }
  }
}

function scheduleStreamReconnect() {
  if (!state.token) return;
  if (state.streamReconnectTimer) return;

  const delay = Math.max(250, Math.min(30000, Number(state.streamRetryMs) || 750));
  state.streamRetryMs = Math.min(30000, Math.round(delay * 1.7));
  state.streamReconnectTimer = setTimeout(() => {
    state.streamReconnectTimer = null;
    startStream();
  }, delay);
}

function stopStream() {
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  if (state.streamReconnectTimer) {
    clearTimeout(state.streamReconnectTimer);
    state.streamReconnectTimer = null;
  }
}

function onStateUpdate(data) {
  const first = !state.data;
  
  // Merge territories to preserve polygons/neighbors if compact update (missing static data)
  if (state.data && state.data.territories && data.territories) {
    const oldMap = new Map(state.data.territories.map(t => [t.id, t]));
    for (const t of data.territories) {
      const old = oldMap.get(t.id);
      if (old) {
        if (!t.polygon || t.polygon.length === 0) {
           t.polygon = old.polygon;
        }
        if (!t.neighbors || t.neighbors.length === 0) {
           t.neighbors = old.neighbors;
        }
      }
    }
  }

  state.data = data;
  const newSig = (state.data?.territories ?? []).map((t) => t.id).join("|");
  const sigChanged = state.territorySig !== null && state.territorySig !== newSig;
  state.territorySig = newSig;

  if (first || sigChanged) {
    initMap();
  } else {
    // ALWAYS update markers if map exists, to reflect lock changes immediately
    if (map) {
       // We can optimize by checking signatures, but user wants robust refresh.
       // Let's re-run marker logic if ownership/locks changed.
       const newOwnerSig = (state.data?.territories ?? []).map(t => `${t.id}:${t.ownerTeamId}:${state.data?.territoryLocks?.[t.id] || ''}:${state.data?.attackLocks?.[t.id] || ''}`).join("|");
       if (state.ownerSig !== newOwnerSig) {
           state.ownerSig = newOwnerSig;
           updateMapMarkers();
       }
    }
  }
  renderLeaderboard();
  applyTerritoryStyles();
  renderAdminBattles();
  renderEventLog();
  const cr = Array.isArray(state.data?.claimRequests) ? state.data.claimRequests : [];
  const pending = cr.filter((r) => r && typeof r === "object" && (r.status ?? "pending") === "pending");
  const vr = Array.isArray(state.data?.claimVerifyRequests) ? state.data.claimVerifyRequests : [];
  const pendingVerify = vr.filter((r) => r && typeof r === "object" && (r.status ?? "pending") === "pending");
  
  if (state.role === "team") {
    const approvedActive = vr
      .filter((r) => r && typeof r === "object" && String(r.status ?? "") === "approved")
      .filter((r) => {
        const exp = Number(r.expiresAtMs ?? 0);
        return Number.isFinite(exp) && nowMs() < exp;
      });
    let latest = null;
    for (const r of approvedActive) {
      if (!latest) latest = r;
      else if (Number(r.resolvedAtMs ?? 0) > Number(latest.resolvedAtMs ?? 0)) latest = r;
    }
    const latestResolved = Number(latest?.resolvedAtMs ?? 0);
    if (latestResolved > Number(state.lastSeenClaimVerifyResolvedAtMs ?? 0)) {
      state.lastSeenClaimVerifyResolvedAtMs = latestResolved;
      const tid = String(latest?.territoryId ?? "");
      if (tid) onTerritoryClicked(tid);
    }
  }

  // Refresh active modal if we were waiting for verification and it is now approved
  if (state.activeTerritoryModalId && state.activeTerritoryModalInfo?.claimVerificationPending) {
    const tid = state.activeTerritoryModalId;
    const isNowApproved = vr.some((r) => 
      String(r.territoryId ?? "") === String(tid) && 
      String(r.status ?? "") === "approved" &&
      Number(r.expiresAtMs ?? 0) > nowMs()
    );
    if (isNowApproved) {
      onTerritoryClicked(tid);
    }
  }

  const cd = state.data?.cooldown;
  const cdUntil = cd?.untilMs ? Number(cd.untilMs) : 0;
  const cdActive = state.role === "team" && Number.isFinite(cdUntil) && nowMs() < cdUntil;
  const cdLeftMs = cdActive ? Math.max(0, cdUntil - nowMs()) : 0;

  if (cdActive && (state.lastCooldownUntilMs === null || cdUntil > Number(state.lastCooldownUntilMs))) {
    const reason = String(cd?.reason ?? "Špatná odpověď");
    openModal({
      title: "Špatná odpověď",
      bodyHtml: `${escapeHtml(reason)}<div class="hint" style="margin-top:8px">Zkus to znovu za ${escapeHtml(formatCountdown(cdLeftMs))}.</div>`,
      actions: [{ label: "OK", onClick: closeModal }]
    });
  }
  state.lastCooldownUntilMs = cdUntil || null;

  if (state.role === "admin") {
    const vr = Array.isArray(state.data?.claimVerifyRequests) ? state.data.claimVerifyRequests : [];
    // Include both pending and approved (waiting for task assignment)
    const pendingVerify = vr.filter((r) => r && typeof r === "object" && ["pending", "approved"].includes(r.status));
    
    const waiting = pendingVerify.length + pending.length;
    if (!waiting) setStatus("Online");
    else if (pendingVerify.length && pending.length) setStatus(`Online — čeká ${pendingVerify.length} ověření/úkolů a ${pending.length} žádostí`);
    else if (pendingVerify.length) setStatus(`Online — čeká ${pendingVerify.length} ověření/úkolů`);
    else setStatus(`Online — čeká ${pending.length} žádostí`);
  } else if (state.role === "team") {
    if (cdActive) setStatus(`Špatná odpověď — blokace ${formatCountdown(cdLeftMs)}`);
    else if (pendingVerify.length) setStatus(`Online — čeká ověření polohy`);
    else setStatus(pending.length ? `Online — čeká ${pending.length} žádostí` : "Online");
  } else {
    setStatus("Online");
  }
}

function applyTeamTheme() {
  const color = state.me?.color || "rgba(255, 255, 255, 0.1)";
  document.documentElement.style.setProperty("--team-color", color);
}

function logout() {
  state.token = null;
  state.role = null;
  state.me = null;
  applyTeamTheme();
  try {
    storage?.removeItem("token");
    storage?.removeItem("role");
    storage?.removeItem("me");
  } catch {
  }
  stopStream();
  stopPolling();
  setAdminPanelVisible(false);
  window.location.href = "/";
}

els.logoutBtn.addEventListener("click", logout);

function formatOwner(ownerTeamId) {
  if (!ownerTeamId) return `<span class="pill"><span class="dot" style="background:rgba(255,255,255,0.25)"></span>Neobsazeno</span>`;
  const t = teamById(ownerTeamId);
  if (!t) return `<span class="pill">Neznámý tým</span>`;
  return `<span class="pill"><span class="dot" style="background:${t.color}"></span>${escapeHtml(t.name)}</span>`;
}

function showTerritoryModal(territoryId, info) {
  const z = territoryById(territoryId);
  if (!z) return;
  state.activeTerritoryModalId = territoryId;
  state.activeTerritoryModalInfo = info;
  
  const isAdmin = state.role === "admin";
  const canActTeam = state.role === "team" && Boolean(state.me);
  const gpsRequired =
    canActTeam && Boolean(state.data?.config?.gpsEnabled) && state.data?.config?.mapMode === "osm";
  const gpsOk = state.gpsOkByTerritoryId.get(territoryId) === true;
  const lockUntilMs = Number(info?.lockUntilMs ?? 0);
  const lockActive = Number.isFinite(lockUntilMs) && nowMs() < lockUntilMs;
  const lockedText = lockActive
    ? `Zamčeno: ${formatCountdown(lockUntilMs - nowMs())}`
    : info.locked
      ? "Zamčeno: už jsi na toto území útočil."
      : "";
  const cdUntil = Number(state.data?.cooldown?.untilMs ?? 0);
  const cdActive = canActTeam && Number.isFinite(cdUntil) && nowMs() < cdUntil;
  const cdLeftMs = cdActive ? Math.max(0, cdUntil - nowMs()) : 0;
  const cdReason = String(state.data?.cooldown?.reason ?? "Špatná odpověď");

  const myClaims = (state.data?.claimRequests ?? [])
    .filter((r) => r && typeof r === "object" && String(r.territoryId ?? "") === String(territoryId))
    .filter((r) => (state.role === "team" ? String(r.teamId ?? "") === String(state.me?.id ?? "") : true))
    .sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  const myLatestClaim = myClaims[0] ?? null;
  const myClaimStatus = myLatestClaim ? String(myLatestClaim.status ?? "pending") : null;

  const verifyPending = Boolean(info?.claimVerificationPending);
  const verifyApproved = Boolean(info?.claimVerificationApproved);
  const verifyExpiresAtMs = Number(info?.claimVerificationExpiresAtMs ?? 0);
  const verifyLeftMs =
    verifyApproved && Number.isFinite(verifyExpiresAtMs) ? Math.max(0, verifyExpiresAtMs - nowMs()) : 0;

  let body = `
    <div>${formatOwner(z.ownerTeamId)}</div>
    <div class="hint">${escapeHtml(lockedText || "")}</div>
  `;

  if (cdActive) {
    body += `<div class="hint" style="margin-top:10px">${escapeHtml(cdReason)} — blokace ${escapeHtml(formatCountdown(cdLeftMs))}</div>`;
  }

  if (lockActive) {
    body += `<div class="hint" style="margin-top:10px">Zamčeno ještě <span id="territoryLockCountdown">${escapeHtml(formatCountdown(lockUntilMs - nowMs()))}</span>.</div>`;
  }

  if (gpsRequired && (info.canClaim)) {
    body += `
      <div style="margin-top:10px">
        <div class="panelTitle">GPS kontrola</div>
        <div class="hint">${gpsOk ? "Poloha ověřena." : "Před akcí ověř polohu (musíš být v území)."}</div>
      </div>
    `;
  }

  if (isAdmin) {
    const options = [
      `<option value="">Neobsazeno</option>`,
      ...(state.data?.teams ?? []).map((t) => {
        const selected = t.id === z.ownerTeamId ? "selected" : "";
        return `<option value="${escapeHtml(t.id)}" ${selected}>${escapeHtml(t.name)}</option>`;
      })
    ].join("");
    body += `
      <div style="margin-top:12px">
        <div class="panelTitle">Admin</div>
        <div class="smallInputRow">
          <div class="label">Vlastník</div>
          <select id="adminOwnerSelect">${options}</select>
        </div>
      </div>
    `;
  }

  if (canActTeam && !isAdmin && !z.ownerTeamId) {
    const leftText = verifyApproved && verifyLeftMs > 0 ? ` — platí ještě ${escapeHtml(formatCountdown(verifyLeftMs))}` : "";
    body += `
      <div style="margin-top:12px">
        <div class="panelTitle">Ověření polohy</div>
        <div class="hint">${
          verifyApproved
            ? `Schváleno adminem${leftText}.`
            : verifyPending
              ? "Čeká na admina."
              : "Čeká na schválení adminem před zobrazením úkolu."
        }</div>
      </div>
    `;
  }

  if (info.canClaim || myClaimStatus || verifyPending || verifyApproved) {
    body += `<div style="margin-top:12px"><div class="panelTitle">Obsazení</div></div>`;
    if (info.claimTask) {
      body += `<div><div class="panelTitle">Úkol</div><div>${escapeHtml(info.claimTask ?? "")}</div></div>`;
    } else if (verifyPending) {
      body += `<div class="hint">Úkol se zobrazí po schválení adminem.</div>`;
    }
    if (myLatestClaim) {
      const st =
        myClaimStatus === "approved"
          ? "Schváleno"
          : myClaimStatus === "rejected"
            ? "Zamítnuto"
            : "Čeká na admina";
      body += `<div class="hint">Stav žádosti: ${escapeHtml(st)}</div>`;
      if (myClaimStatus === "pending") {
        body += `<div style="margin-top:10px"><div class="panelTitle">Odpověď</div><div>${escapeHtml(String(myLatestClaim.answer ?? "") || "(bez odpovědi)")}</div></div>`;
      }
    }
    if (canActTeam && info.canClaim && myClaimStatus !== "pending") {
      body += `<div style="margin-top:10px" class="smallInputRow"><div class="label">Odpověď</div><input id="claimAnswer" type="text" maxlength="500"></div>`;
    }
  }

  if (!isAdmin && !canActTeam) {
    body += `<div class="hint" style="margin-top:10px">Pro akce se přihlas.</div>`;
  }

  const actions = [
    { label: "Zavřít", onClick: closeModal }
  ];

  if (canActTeam && gpsRequired && (info.canClaim)) {
    actions.unshift({
      label: gpsOk ? "Odeslat polohu" : "Ověřit GPS",
      kind: "primary",
      onClick: async () => {
        try {
          const point = await getGpsPosition();
          // Optional check: warn if outside, but still allow sending? 
          // User said "admin confirms or not", implying we should send it.
          // But maybe we should warn the user they are outside?
          const inside = pointInPolygon(point, z.polygon);
          if (!inside) {
             if (!confirm("Podle GPS jsi mimo vyznačené území. Chceš přesto odeslat žádost?")) {
                 return;
             }
          }

          state.gpsOkByTerritoryId.set(territoryId, true);
          
          await apiPost("/api/territory/claimVerifyRequest", { 
             token: state.token, 
             territoryId,
             lat: point[0],
             lng: point[1]
          });

          apiPost("/api/territory/info", { token: state.token, territoryId })
            .then((payload) => showTerritoryModal(territoryId, payload))
            .catch(() => {});
        } catch (e) {
          openModal({
            title: "GPS",
            bodyHtml: escapeHtml(e?.message ?? "Nepodařilo se ověřit polohu."),
            actions: [{ label: "OK", onClick: closeModal }]
          });
        }
      }
    });
  }

  if (isAdmin) {
    if (!state.data?.config?.gameLocked) {
      actions.unshift({
        label: "Uložit vlastníka",
        kind: "primary",
        onClick: () => {
          const ownerTeamId = document.getElementById("adminOwnerSelect")?.value ?? "";
          apiPost("/api/admin/territory/setOwner", { token: state.token, territoryId, ownerTeamId })
            .then(() => {
              closeModal();
              forceRefresh();
            })
            .catch((e) => {
              openModal({
                title: "Chyba",
                bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
                actions: [{ label: "OK", onClick: closeModal }]
              });
            });
        }
      });
    }
  }

  if (canActTeam && info.canClaim && !state.data?.config?.gameLocked) {
    actions.unshift({
      label: "Odeslat žádost",
      kind: "primary",
      onClick: () => {
        const gpsRequiredNow =
          Boolean(state.data?.config?.gpsEnabled) && state.data?.config?.mapMode === "osm";
        const gpsOkNow = state.gpsOkByTerritoryId.get(territoryId) === true;
        if (gpsRequiredNow && !gpsOkNow) {
          openModal({
            title: "GPS",
            bodyHtml: "Nejdřív ověř polohu (tlačítko Ověřit GPS).",
            actions: [{ label: "OK", onClick: closeModal }]
          });
          return;
        }
        const answer = document.getElementById("claimAnswer")?.value ?? "";
        const fileInput = document.getElementById("claimImage");
        const file = fileInput?.files?.[0];

        if (!String(answer).trim() && !file) {
          openModal({
            title: "Obsazení",
            bodyHtml: "Vyplň odpověď nebo nahraj fotku.",
            actions: [{ label: "OK", onClick: closeModal }]
          });
          return;
        }
        
        const send = (imgData) => {
            apiPost("/api/territory/claimRequest", { 
                token: state.token, 
                territoryId, 
                answer,
                image: imgData
            })
            .then(() => {
                closeModal();
                forceRefresh();
            })
            .catch((e) => {
                openModal({
                title: "Chyba",
                bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
                actions: [{ label: "OK", onClick: closeModal }]
                });
            });
        };

        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => send(e.target.result);
            reader.readAsDataURL(file);
        } else {
            send(null);
        }
      }
    });
  }

  openModal({ title: z.name, bodyHtml: body, actions });
}

function onTerritoryClicked(territoryId) {
  if (!state.token) {
    openModal({
      title: "Přihlášení",
      bodyHtml: "Pro zobrazení úkolu a akcí se nejdřív přihlas v levém panelu.",
      actions: [{ label: "OK", onClick: closeModal }]
    });
    return;
  }
  apiPost("/api/territory/info", { token: state.token, territoryId })
    .then(async (payload) => {
      if (state.role === "team" && state.me && payload?.canRequestClaimVerification && !state.data?.config?.gameLocked) {
        try {
          // If we have GPS coords cached/fresh, use them
          // But verifyGpsInsideTerritory is async and requires user action usually (browser permission).
          // However, onTerritoryClicked is triggered by user click.
          // We can try to get GPS if we don't have it, but better to let user click "Verify GPS".
          // But wait, the previous code auto-requested verification?
          // "await apiPost("/api/territory/claimVerifyRequest", { token: state.token, territoryId });"
          // We need coords now. So we CANNOT auto-request without coords.
          // We will rely on the "Ověřit GPS" button inside the modal to trigger the request.
        } catch {
        }
      }
      showTerritoryModal(territoryId, payload);
    })
    .catch((e) => {
      openModal({
        title: "Chyba",
        bodyHtml: escapeHtml(e?.message ?? "Neznámá chyba."),
        actions: [{ label: "OK", onClick: closeModal }]
      });
    });
}

function verifyGpsInsideTerritory(territory) {
  if (!navigator.geolocation) throw new Error("Tento prohlížeč nepodporuje GPS.");

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const point = [pos.coords.latitude, pos.coords.longitude];
        const poly = territory.polygon;
        if (!Array.isArray(poly) || poly.length < 3) {
          reject(new Error("Území nemá polygon."));
          return;
        }
        const inside = pointInPolygon(point, poly);
        if (!inside) {
          reject(new Error("Jsi mimo hranice území."));
          return;
        }
        resolve(point);
      },
      (err) => {
        reject(new Error("Nepodařilo se získat polohu (povolte GPS)."));
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 5000
      }
    );
  });
}

function getGpsPosition() {
  if (!navigator.geolocation) throw new Error("Tento prohlížeč nepodporuje GPS.");

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        resolve([pos.coords.latitude, pos.coords.longitude]);
      },
      (err) => {
        reject(new Error("Nepodařilo se získat polohu (povolte GPS)."));
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  });
}

// Sidebar Toggle
const menuToggleBtn = document.getElementById("menuToggleBtn");
const sidebar = document.querySelector(".sidebar");
const sidebarOverlay = document.getElementById("sidebarOverlay");

if (menuToggleBtn && sidebar && sidebarOverlay) {
  const toggle = () => {
    sidebar.classList.toggle("open");
    sidebarOverlay.classList.toggle("open");
  };
  menuToggleBtn.addEventListener("click", toggle);
  sidebarOverlay.addEventListener("click", toggle);
}

// Start
loadInitialState()
  .then(() => {
     startStream();
  })
  .catch((e) => {
    setStatus("Chyba načítání: " + e.message);
    console.error(e);
    // Retry
    setTimeout(() => window.location.reload(), 3000);
  });

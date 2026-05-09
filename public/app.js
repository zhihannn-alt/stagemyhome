const state = {
  jobs: [],
  activeJob: null,
  config: { watchPhone: "", bridgeURL: "http://localhost:8080", hasOpenAIKey: false },
  busy: false,
  error: "",
  selected: {},
  collapsedGroups: {}
};

const $ = selector => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  })[char]);
}

function statusLabel(status) {
  return String(status || "WAITING").replaceAll("_", " ");
}

function setActiveJob(job) {
  state.activeJob = job || null;
  state.selected = job?.selected || {};
}

async function refreshJobs() {
  const response = await fetch("/api/jobs");
  const payload = await response.json();
  state.jobs = payload.jobs || [];
  if (!state.activeJob && state.jobs.length) setActiveJob(state.jobs[0]);
  if (state.activeJob) {
    const fresh = state.jobs.find(job => job.id === state.activeJob.id);
    if (fresh) setActiveJob(fresh);
  }
}

async function loadConfig() {
  const response = await fetch("/api/demo-config");
  state.config = await response.json();
}

async function jobAction(action) {
  if (!state.activeJob) return;
  state.error = "";
  const response = await fetch("/api/job-action", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: state.activeJob.id, action })
  });
  const payload = await response.json();
  if (!response.ok) state.error = payload.error || "Could not update job.";
  await refreshJobs();
  render();
}

async function generateImages() {
  if (!state.activeJob) return;
  state.busy = true;
  state.error = "";
  render();
  try {
    const rooms = state.activeJob.rooms.map(room => ({
      ...room,
      finalPrompt: $(`#prompt-${room.id}`)?.value || room.suggestedPrompt
    }));
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: state.activeJob.id, rooms, variantsPerRoom: 1 })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Generation failed.");
    await refreshJobs();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

function selectImage(roomId, image) {
  state.selected[roomId] = image;
  render();
}

async function finaliseDelivery() {
  if (!state.activeJob) return;
  state.busy = true;
  state.error = "";
  render();
  try {
    const selected = Object.entries(state.selected).map(([roomId, image]) => ({ roomId, image }));
    const response = await fetch("/api/compile", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: state.activeJob.id,
        agentNumber: state.activeJob.agentNumber,
        projectName: state.activeJob.projectName,
        selected,
        rooms: state.activeJob.rooms
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "Delivery failed.");
    await refreshJobs();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.busy = false;
    render();
  }
}

// ── Stepper ───────────────────────────────────────────────

const STEPS = [
  { key: "AWAITING_RESPONSES", label: "Photos received" },
  { key: "AGENT_RESPONDED",    label: "Agent replied" },
  { key: "PENDING_PAYMENT",    label: "Awaiting payment" },
  { key: "PAYMENT_VERIFIED",   label: "Payment verified" },
  { key: "AWAITING_CURATION",  label: "Images generated" },
  { key: "COMPLETE",           label: "Delivered" }
];

function stepIndex(status) {
  const idx = STEPS.findIndex(s => s.key === status);
  return idx === -1 ? 0 : idx;
}

function renderStepper() {
  const current = stepIndex(state.activeJob?.status || "AWAITING_RESPONSES");
  return `<div class="stepper">
    ${STEPS.map((step, i) => {
      const cls = i < current ? "done" : i === current ? "active" : "";
      return `<div class="step-item ${cls}">
        <div class="step-dot">${i < current ? "✓" : i + 1}</div>
        <span>${step.label}</span>
      </div>`;
    }).join('<div class="step-line"></div>')}
  </div>`;
}

// ── Status-driven action bar ──────────────────────────────

function renderActionBar() {
  const job = state.activeJob;
  if (!job) return "";
  const busy = state.busy;
  const roomCount = job.rooms?.length || 0;
  const selectedCount = Object.keys(state.selected).length;

  switch (job.status) {
    case "AWAITING_RESPONSES":
      return `<div class="action-bar waiting">
        <span class="action-hint">⏳ Waiting for agent to reply via WhatsApp</span>
        <button class="action-btn-secondary" id="simulate-response" ${busy ? "disabled" : ""}>
          Simulate agent response
        </button>
      </div>`;

    case "AGENT_RESPONDED":
      return `<div class="action-bar">
        ${job.agentNotes ? `<p class="agent-quote">"${escapeHtml(job.agentNotes)}"</p>` : ""}
        <button class="action-btn green" id="agent-confirmed" ${busy ? "disabled" : ""}>
          Confirm agent response
        </button>
      </div>`;

    case "PENDING_PAYMENT":
      return `<div class="action-bar">
        <div class="action-hint">Invoice sent to ${escapeHtml(job.agentNumber)}</div>
        <button class="action-btn gold" id="verify-payment" ${busy ? "disabled" : ""}>
          Verify payment
        </button>
      </div>`;

    case "PAYMENT_VERIFIED":
      return `<div class="action-bar">
        <div class="action-hint">${roomCount} room${roomCount !== 1 ? "s" : ""} ready to stage</div>
        <button class="action-btn green" id="generate" ${busy ? "disabled" : ""}>
          Generate staged images
        </button>
      </div>`;

    case "GENERATING":
      return `<div class="action-bar waiting">
        <span class="action-hint">⚙️ Generating images… this may take a minute</span>
        <button class="action-btn-secondary" id="reset-generating" ${busy ? "disabled" : ""}>
          Reset (stuck?)
        </button>
      </div>`;

    case "AWAITING_CURATION": {
      const allSelected = selectedCount === roomCount;
      return `<div class="action-bar ${allSelected ? "" : "waiting"}">
        <div class="action-hint">${selectedCount} of ${roomCount} rooms selected</div>
        <button class="action-btn" id="finalise" ${allSelected && !busy ? "" : "disabled"}>
          Deliver to agent (${selectedCount}/${roomCount})
        </button>
        <button class="action-btn-secondary" id="generate" ${busy ? "disabled" : ""}>
          Regenerate
        </button>
      </div>`;
    }

    case "COMPLETE":
      return `<div class="action-bar complete">
        <span class="action-hint">✓ Delivered to ${escapeHtml(job.agentNumber)}</span>
        ${job.driveLink ? `<a href="${escapeHtml(job.driveLink)}" target="_blank" class="pill good">View delivery link</a>` : ""}
        <button class="action-btn-secondary" id="generate" ${busy ? "disabled" : ""}>Regenerate</button>
      </div>`;

    default:
      return "";
  }
}

// ── Room cards ────────────────────────────────────────────

function renderRoomCard(room) {
  const job = state.activeJob;
  const inCuration = ["AWAITING_CURATION", "COMPLETE"].includes(job?.status);
  const variants = job?.generated?.[room.id] || [];
  const selectedId = state.selected[room.id]?.id;

  return `<div class="room-card">
    <div class="room-source">
      <img src="${escapeHtml(room.sourceUrl)}" alt="${escapeHtml(room.room)}" />
      <div class="room-meta">
        <strong>${escapeHtml(room.index)}. ${escapeHtml(room.room)}</strong>
        <span>${escapeHtml(room.condition)}</span>
      </div>
    </div>
    ${inCuration ? `
      <div class="room-variants">
        ${variants.length ? variants.map(img => `
          <button class="variant ${selectedId === img.id ? "selected" : ""}" data-room="${room.id}" data-image="${img.id}">
            <img src="${escapeHtml(img.url)}" alt="Staged" />
            ${selectedId === img.id ? `<div class="variant-check">✓</div>` : ""}
          </button>
        `).join("") : `<div class="variant-empty">No images yet</div>`}
      </div>
    ` : `
      <div class="room-detail">
        ${room.agentNotes || job?.agentNotes ? `
          <p class="room-pref">${escapeHtml(room.agentNotes || job.agentNotes)}</p>
        ` : ""}
        <textarea id="prompt-${room.id}" class="prompt">${escapeHtml(room.suggestedPrompt)}</textarea>
      </div>
    `}
  </div>`;
}

// ── Grouped sidebar ───────────────────────────────────────

function groupJobsByPhone(jobs) {
  const order = [];
  const groups = {};
  for (const job of jobs) {
    const phone = job.agentNumber || "unknown";
    if (!groups[phone]) {
      groups[phone] = [];
      order.push(phone);
    }
    groups[phone].push(job);
  }
  return { order, groups };
}

function formatPhone(phone) {
  if (!phone || phone === "unknown") return "Unknown";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length >= 11 && digits.startsWith("65")) return `+65 ${digits.slice(2, 6)} ${digits.slice(6)}`;
  if (digits.length >= 10 && digits.startsWith("1")) return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  if (digits.length >= 8) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return phone;
}

function renderSidebar() {
  if (!state.jobs.length) {
    return `<div class="empty">Waiting for WhatsApp messages.</div>`;
  }

  const { order, groups } = groupJobsByPhone(state.jobs);

  if (order.length === 1) {
    return groups[order[0]].map(j => renderJobRow(j)).join("");
  }

  return order.map(phone => {
    const groupJobs = groups[phone];
    const collapsed = state.collapsedGroups[phone];
    const hasActive = groupJobs.some(j => j.id === state.activeJob?.id);
    return `
      <div class="phone-group ${hasActive ? "has-active" : ""}">
        <button class="phone-group-header" data-phone="${escapeHtml(phone)}">
          <span class="phone-label">${escapeHtml(formatPhone(phone))}</span>
          <span class="phone-count">${groupJobs.length} project${groupJobs.length !== 1 ? "s" : ""}</span>
          <span class="phone-chevron">${collapsed ? "▶" : "▼"}</span>
        </button>
        ${collapsed ? "" : `<div class="phone-group-jobs">${groupJobs.map(j => renderJobRow(j)).join("")}</div>`}
      </div>
    `;
  }).join("");
}

function renderJobRow(j) {
  return `<button class="job-row ${state.activeJob?.id === j.id ? "selected" : ""}" data-job="${j.id}">
    <strong>${escapeHtml(j.projectName || "WhatsApp Project")}</strong>
    <span class="job-status-badge ${j.status === "COMPLETE" ? "done" : ""}">${escapeHtml(statusLabel(j.status))}</span>
  </button>`;
}

// ── Main render ───────────────────────────────────────────

function renderApp() {
  const job = state.activeJob;

  return `
    <div class="shell">
      <header class="topbar">
        <div class="brand">
          <div class="mark">S</div>
          <div>
            <h1>StageMyHome</h1>
            <p>Operator dashboard</p>
          </div>
        </div>
        <div class="statusbar">
          <span class="pill ${state.config.hasOpenAIKey ? "good" : ""}">${state.config.hasOpenAIKey ? "OpenAI ready" : "OpenAI missing"}</span>
        </div>
      </header>

      <div class="dashboard">
        <aside class="sidebar panel">
          <div class="panel-head">
            <h2>Jobs</h2>
            <button class="seed-btn" id="seed-demo">+ Demo data</button>
          </div>
          <div class="panel-body job-list">
            ${renderSidebar()}
          </div>
        </aside>

        <main class="maincol">
          ${job ? `
            <div class="project-header">
              <div>
                <h2>${escapeHtml(job.projectName)}</h2>
                <p class="subtle">${escapeHtml(formatPhone(job.agentNumber))} · ${job.rooms?.length || 0} rooms</p>
              </div>
            </div>

            ${renderStepper()}

            ${state.error ? `<div class="error-bar">${escapeHtml(state.error)}</div>` : ""}

            ${renderActionBar()}

            <div class="rooms-grid">
              ${(job.rooms || []).map(room => renderRoomCard(room)).join("")}
            </div>
          ` : `
            <div class="empty-state">
              <div class="empty-icon">📱</div>
              <h3>Waiting for WhatsApp</h3>
              <p>When a property agent sends photos, the job will appear here.</p>
            </div>
          `}
        </main>
      </div>
    </div>
  `;
}

function bindEvents() {
  document.querySelectorAll(".job-row").forEach(button => {
    button.addEventListener("click", () => {
      setActiveJob(state.jobs.find(job => job.id === button.dataset.job));
      render();
    });
  });
  document.querySelectorAll(".phone-group-header").forEach(button => {
    button.addEventListener("click", () => {
      const phone = button.dataset.phone;
      state.collapsedGroups[phone] = !state.collapsedGroups[phone];
      render();
    });
  });
  $("#seed-demo")?.addEventListener("click", async () => {
    await fetch("/api/seed-demo", { method: "POST" });
    await refreshJobs();
    render();
  });
  $("#agent-confirmed")?.addEventListener("click", () => jobAction("agent_confirmed"));
  $("#verify-payment")?.addEventListener("click", () => jobAction("verify_payment"));
  $("#simulate-response")?.addEventListener("click", () => jobAction("simulate_agent_response"));
  $("#reset-generating")?.addEventListener("click", () => jobAction("reset_generating"));
  $("#generate")?.addEventListener("click", generateImages);
  $("#finalise")?.addEventListener("click", finaliseDelivery);
  document.querySelectorAll(".variant").forEach(button => {
    button.addEventListener("click", () => {
      const image = (state.activeJob?.generated?.[button.dataset.room] || []).find(item => item.id === button.dataset.image);
      if (image) selectImage(button.dataset.room, image);
    });
  });
}

function render() {
  $("#app").innerHTML = renderApp();
  bindEvents();
}

async function boot() {
  await loadConfig();
  await refreshJobs();
  render();
  setInterval(async () => {
    await refreshJobs();
    render();
  }, 3000);
}

boot();

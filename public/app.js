const state = {
  jobs: [],
  activeJob: null,
  config: { watchPhone: "", bridgeURL: "http://localhost:8080", hasOpenAIKey: false },
  busy: false,
  error: "",
  selected: {}
};

const $ = selector => document.querySelector(selector);

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
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

function renderJobs() {
  if (!state.jobs.length) {
    return `<div class="empty">Waiting for WhatsApp messages from the watched phone number.</div>`;
  }
  return state.jobs.map(job => `
    <button class="job-row ${state.activeJob?.id === job.id ? "selected" : ""}" data-job="${job.id}">
      <strong>${escapeHtml(job.projectName || "WhatsApp Project")}</strong>
      <span>${escapeHtml(job.agentNumber)} · ${escapeHtml(statusLabel(job.status))}</span>
    </button>
  `).join("");
}

function renderRooms() {
  const job = state.activeJob;
  if (!job) return `<div class="empty">Select a job to review room analysis.</div>`;
  return job.rooms.map(room => `
    <article class="room">
      <img src="${room.sourceUrl}" alt="${escapeHtml(room.room)}" />
      <div>
        <h3>${escapeHtml(room.index)}. ${escapeHtml(room.room)}</h3>
        <p>${escapeHtml(room.condition)} · ${escapeHtml((room.features || []).join(", "))}</p>
        <ol class="questions">${(room.questions || []).map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ol>
        <textarea id="prompt-${room.id}" class="prompt">${escapeHtml(room.suggestedPrompt)}</textarea>
      </div>
    </article>
  `).join("");
}

function renderGenerated() {
  const job = state.activeJob;
  if (!job) return `<div class="empty">Generated images will appear after payment verification.</div>`;
  const generated = job.generated || {};
  if (!Object.keys(generated).length) return `<div class="empty">No generated images yet.</div>`;
  return job.rooms.map(room => `
    <section class="generated-room">
      <h3>${escapeHtml(room.room)}</h3>
      <div class="image-grid">
        ${(generated[room.id] || []).map(image => `
          <button class="candidate ${state.selected[room.id]?.id === image.id ? "selected" : ""}" data-room="${room.id}" data-image="${image.id}">
            <img src="${image.url}" alt="${escapeHtml(room.room)} generated" />
            <span>${image.mock ? "mock source" : "generated image"}</span>
          </button>
        `).join("")}
      </div>
    </section>
  `).join("");
}

function renderTimeline() {
  const status = state.activeJob?.status || "WAITING_FOR_WHATSAPP";
  const steps = ["AWAITING_RESPONSES", "AGENT_RESPONDED", "PENDING_PAYMENT", "PAYMENT_VERIFIED", "GENERATING", "AWAITING_CURATION", "COMPLETE"];
  return steps.map(step => `<span class="flow-step ${status === step ? "active" : ""}">${escapeHtml(statusLabel(step))}</span>`).join("");
}

function renderApp() {
  const job = state.activeJob;
  const generated = job?.generated || {};
  const selectedCount = Object.keys(state.selected).length;
  const roomCount = job?.rooms?.length || 0;
  const canFinalise = roomCount > 0 && selectedCount === roomCount;

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
          <span class="pill">Bridge ${escapeHtml(state.config.bridgeURL || "local")}</span>
        </div>
      </header>

      <main class="dashboard">
        <aside class="sidebar panel">
          <div class="panel-head"><h2>Jobs</h2></div>
          <div class="panel-body job-list">${renderJobs()}</div>
        </aside>

        <section class="maincol grid">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>${job ? escapeHtml(job.projectName) : "No Active Job"}</h2>
                <p class="subtle">${job ? `${escapeHtml(job.agentNumber)} · ${escapeHtml(statusLabel(job.status))}` : "Waiting for WhatsApp intake"}</p>
              </div>
              <div class="toolbar">
                <button class="secondary" id="agent-confirmed" ${job && !state.busy ? "" : "disabled"}>Agent Confirmed</button>
                <button class="gold" id="verify-payment" ${job && !state.busy ? "" : "disabled"}>Verify Payment</button>
                <button class="green" id="generate" ${job && !state.busy ? "" : "disabled"}>${Object.keys(generated).length ? "Rerun" : "Generate"}</button>
                <button id="finalise" ${canFinalise && !state.busy ? "" : "disabled"}>Finalise Delivery</button>
              </div>
            </div>
            <div class="panel-body">
              <div class="flow">${renderTimeline()}</div>
              ${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ""}
              ${job?.agentNotes ? `<p class="note"><strong>Agent preference:</strong> ${escapeHtml(job.agentNotes)}</p>` : ""}
              ${job?.driveLink ? `<p class="note">Delivery link: <a href="${job.driveLink}" target="_blank">${escapeHtml(job.driveLink)}</a></p>` : ""}
            </div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Room Analysis</h2><span class="pill">${roomCount} rooms</span></div>
            <div class="panel-body rooms">${renderRooms()}</div>
          </section>

          <section class="panel">
            <div class="panel-head"><h2>Curation</h2><span class="pill">${selectedCount} / ${roomCount} selected</span></div>
            <div class="panel-body grid">${renderGenerated()}</div>
          </section>
        </section>
      </main>
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
  $("#agent-confirmed")?.addEventListener("click", () => jobAction("agent_confirmed"));
  $("#verify-payment")?.addEventListener("click", () => jobAction("verify_payment"));
  $("#generate")?.addEventListener("click", generateImages);
  $("#finalise")?.addEventListener("click", finaliseDelivery);
  document.querySelectorAll(".candidate").forEach(button => {
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

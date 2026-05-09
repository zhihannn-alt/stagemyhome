import http from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const uploadsDir = path.join(__dirname, "uploads");
const generatedDir = path.join(__dirname, "generated");

await loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 5173);
let openAIKey = process.env.OPENAI_API_KEY || "";
let analysisModel = process.env.OPENAI_ANALYSIS_MODEL || "gpt-5.1";
let imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1.5";
let googleClientId = process.env.GOOGLE_CLIENT_ID || "";
let googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
let googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/google/callback`;
let googleTokens = null;
let watchPhone = process.env.DEMO_WATCH_PHONE || "";
let bridgeURL = process.env.WHATSAPP_BRIDGE_URL || "http://localhost:8080";
const jobs = new Map();

const mimeByExt = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

const roomSchema = {
  name: "room_analysis",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      room: { type: "string" },
      condition: { type: "string", enum: ["messy", "cluttered", "lived-in", "empty", "neat", "new", "renovated", "unknown"] },
      features: { type: "array", items: { type: "string" } },
      questions: { type: "array", minItems: 2, maxItems: 3, items: { type: "string" } },
      suggestedPrompt: { type: "string" }
    },
    required: ["room", "condition", "features", "questions", "suggestedPrompt"]
  }
};

await mkdir(uploadsDir, { recursive: true });
await mkdir(generatedDir, { recursive: true });

async function loadDotEnv(filePath) {
  if (!existsSync(filePath)) return;
  const text = await readFile(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const raw = trimmed.slice(eq + 1).trim();
    const value = raw.replace(/^['"]|['"]$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function publicJob(job) {
  return {
    id: job.id,
    agentNumber: job.agentNumber,
    projectName: job.projectName,
    status: job.status,
    rooms: job.rooms,
    generated: job.generated || {},
    selected: job.selected || {},
    driveLink: job.driveLink || "",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  jobs.set(job.id, job);
  return job;
}

function createJob({ agentNumber, projectName, rooms, status = "AWAITING_RESPONSES" }) {
  return saveJob({
    id: `SMH-${Date.now().toString(36).toUpperCase()}`,
    agentNumber,
    projectName,
    rooms,
    status,
    generated: {},
    selected: {},
    driveLink: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

function safeName(value) {
  return String(value || "file")
    .replace(/[^a-z0-9._-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 90);
}

function safeSegment(value, fallback) {
  return safeName(value || fallback).replace(/\.+/g, ".") || fallback;
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || "unknown-phone";
}

function isWatchedPhone(value) {
  const watched = normalizePhone(watchPhone);
  if (!watchPhone || watched === "unknown-phone") return true;
  return normalizePhone(value).endsWith(watched) || watched.endsWith(normalizePhone(value));
}

function conditionBucket(condition) {
  const text = String(condition || "").toLowerCase();
  if (/\b(messy|clutter|lived|dirty|personal|untidy)\b/.test(text)) return "messy";
  if (/\b(neat|new|renovated|clean|showflat|showroom)\b/.test(text)) return "neat";
  if (/\b(empty|vacant|bare)\b/.test(text)) return "empty";
  return "unknown";
}

async function nodeRequestToWeb(req) {
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ["GET", "HEAD"].includes(req.method) ? undefined : ReadableStreamFromNode(req),
    duplex: "half"
  });
}

function ReadableStreamFromNode(req) {
  return new ReadableStream({
    start(controller) {
      req.on("data", chunk => controller.enqueue(chunk));
      req.on("end", () => controller.close());
      req.on("error", err => controller.error(err));
    }
  });
}

async function fileToDataUrl(file) {
  const buffer = Buffer.from(await file.arrayBuffer());
  const mime = file.type || "image/jpeg";
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

function extractTextFromOpenAI(data) {
  if (data.output_text) return data.output_text;
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (content.text) chunks.push(content.text);
    }
  }
  return chunks.join("\n");
}

function inferRoomFromText(fileName, hint, index) {
  const text = `${hint || ""} ${fileName || ""}`.toLowerCase();
  const patterns = [
    ["Living Room", /\b(living|lounge|hall|sitting|family)\b/],
    ["Master Bedroom", /\b(master|primary)\b/],
    ["Bedroom", /\b(bed|bedroom|br|guest)\b/],
    ["Kitchen", /\b(kitchen|pantry|cook)\b/],
    ["Dining Room", /\b(dining|dinner)\b/],
    ["Bathroom", /\b(bath|toilet|wc|ensuite|powder)\b/],
    ["Study", /\b(study|office|work|desk)\b/],
    ["Balcony", /\b(balcony|terrace|patio|deck)\b/],
    ["Corridor", /\b(corridor|hallway|entry|foyer)\b/]
  ];
  if (hint && hint.trim()) return hint.trim();
  const match = patterns.find(([, pattern]) => pattern.test(text));
  return match ? match[0] : `Room ${index}`;
}

function roomQuestions(room, condition = "unknown") {
  const lower = room.toLowerCase();
  const bucket = conditionBucket(condition);
  if (bucket === "messy") {
    return [
      "Should we tidy and lightly stage the existing room, or completely revamp it with new furniture?",
      "Any personal items, bulky furniture, or colors you definitely want removed?",
      "What final style should buyers see: modern luxury, Scandinavian, Japandi, or family-friendly?"
    ];
  }
  if (bucket === "neat") {
    return [
      "The room already looks clean. Do you want a different overall style, or only specific furniture/decor changes?",
      "Which items should stay exactly as-is, and which should be replaced?",
      "Should the final image feel more premium, warmer, brighter, or more minimalist?"
    ];
  }
  if (bucket === "empty") {
    return [
      "Should this be staged as move-in ready, premium showflat, or simple rental-friendly?",
      "What furniture layout should we suggest for buyers viewing this room?"
    ];
  }
  if (lower.includes("bed")) {
    return [
      "Should this feel like a hotel-style master suite, a warm family bedroom, or a minimalist retreat?",
      "Any preferred bedding color palette or material, such as linen, oak, or darker wood?"
    ];
  }
  if (lower.includes("kitchen")) {
    return [
      "Should the kitchen feel sleek modern, warm Scandinavian, or premium condo-style?",
      "Should we add small styling props such as bar stools, plants, and countertop decor?"
    ];
  }
  if (lower.includes("living")) {
    return [
      "What style should the living room use: modern luxury, Scandinavian, Japandi, or family-friendly?",
      "Should the staging emphasize entertaining, relaxation, or a bright open-plan feel?"
    ];
  }
  if (lower.includes("bath")) {
    return [
      "Should the bathroom feel spa-like, hotel-clean, or simple and practical?",
      "Any preferred towel/accessory color palette?"
    ];
  }
  return [
    "What staging style should this room use?",
    "Any colors, furniture types, or mood to avoid?"
  ];
}

function buildStagingPrompt(room, features, preferenceText) {
  const preserved = features?.length ? features.join(", ") : "the exact walls, windows, doors, flooring, ceiling, built-ins, and camera angle";
  return [
    `Edit the provided property photo into a photorealistic staged ${room.toLowerCase()} for a premium Singapore real estate listing.`,
    `Preserve the original room type and the exact architecture: ${preserved}.`,
    "Do not change the floor plan, walls, windows, doors, ceiling, view, camera angle, or structural features.",
    "Remove clutter and personal items. Add tasteful listing-ready furniture and decor only where physically plausible.",
    preferenceText ? `Agent preference: ${preferenceText}` : "Use bright, airy contemporary styling with natural light and neutral colors.",
    "No text, no watermark, no logos, no people, no unrealistic furniture scale."
  ].join(" ");
}

async function analyzeRoom(file, index, recommendedPrompt, roomHint) {
  if (!openAIKey) {
    const room = inferRoomFromText(file.name, roomHint, index);
    const features = ["existing room geometry", "windows and fixed structural elements"];
    const condition = "unknown";
    return {
      id: crypto.randomUUID(),
      index,
      fileName: file.name,
      room,
      condition,
      features,
      questions: roomQuestions(room, condition),
      suggestedPrompt: buildStagingPrompt(room, features, recommendedPrompt),
      mock: true
    };
  }

  const dataUrl = await fileToDataUrl(file);
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      authorization: `Bearer ${openAIKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: analysisModel,
      input: [
        {
          role: "system",
          content:
            "You are a professional interior staging consultant for Singapore property agents. Return only JSON that matches the schema."
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Analyze this property photo for virtual staging. Identify the visible room type. If a human supplied a room label hint, prefer it unless the image clearly contradicts it. Classify condition as messy, cluttered, lived-in, empty, neat, new, renovated, or unknown. Describe only fixed features that must be preserved. Generate smart questions for the property agent: if messy/cluttered/lived-in, ask whether to tidy/lightly stage or totally revamp; if neat/new/renovated, ask whether they want a different style or specific furniture changes; if empty, ask desired layout and staging style. Build a staging prompt that edits the same photo rather than generating a new room. The prompt must explicitly preserve room geometry, fixed architecture, camera angle, windows, doors, flooring, ceiling, and views. Brand context: StageMyHome. Room label hint: " +
                (roomHint || "none") +
                ". Recommended user prompt guidance: " +
                (recommendedPrompt || "none")
            },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          ...roomSchema
        }
      }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Room analysis failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const parsed = JSON.parse(extractTextFromOpenAI(data));
  const features = parsed.features?.length ? parsed.features : ["existing room geometry", "fixed structural elements"];
  const room = roomHint?.trim() || parsed.room;
  const condition = parsed.condition || "unknown";
  return {
    id: crypto.randomUUID(),
    index,
    fileName: file.name,
    ...parsed,
    room,
    condition,
    features,
    questions: roomQuestions(room, condition),
    suggestedPrompt: buildStagingPrompt(room, features, `${recommendedPrompt}\n${parsed.suggestedPrompt || ""}`.trim())
  };
}

async function saveUpload(file, prefix, agentNumber = "", projectName = "") {
  const ext = path.extname(file.name) || ".jpg";
  const folder = path.join(uploadsDir, normalizePhone(agentNumber), safeSegment(projectName, "default-project"));
  await mkdir(folder, { recursive: true });
  const name = `${prefix}_${crypto.randomUUID()}_${safeName(file.name || `photo${ext}`)}`;
  const target = path.join(folder, name);
  await writeFile(target, Buffer.from(await file.arrayBuffer()));
  return {
    path: target,
    url: `/uploads/${normalizePhone(agentNumber)}/${safeSegment(projectName, "default-project")}/${name}`
  };
}

async function handleAnalyze(req, res) {
  const webReq = await nodeRequestToWeb(req);
  const form = await webReq.formData();
  const files = form.getAll("photos").filter(item => item && typeof item.arrayBuffer === "function");
  const recommendedPrompt = String(form.get("recommendedPrompt") || "");
  const agentNumber = String(form.get("agentNumber") || "");
  const projectName = String(form.get("projectName") || "default-project");
  const roomHints = String(form.get("roomHints") || "")
    .split(/\r?\n/)
    .map(item => item.trim())
    .filter(Boolean);

  if (!files.length) return sendJson(res, 400, { error: "Upload at least one property photo." });

  const rooms = [];
  for (let i = 0; i < files.length; i += 1) {
    const saved = await saveUpload(files[i], "source", agentNumber, projectName);
    const room = await analyzeRoom(files[i], i + 1, recommendedPrompt, roomHints[i] || "");
    rooms.push({
      ...room,
      agentNumber,
      projectName,
      sourceUrl: saved.url,
      sourcePath: saved.path,
      sourceMime: files[i].type || "image/jpeg"
    });
  }
  const job = createJob({ agentNumber, projectName, rooms, status: "AWAITING_RESPONSES" });
  sendJson(res, 200, { job: publicJob(job), rooms });
}

async function handleWhatsAppInbound(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const agentNumber = String(body.agentNumber || body.phone || "");
  const projectName = String(body.projectName || body.project || "whatsapp-project");
  const recommendedPrompt = String(body.recommendedPrompt || "");
  const roomHints = Array.isArray(body.roomHints) ? body.roomHints : [];
  const photos = Array.isArray(body.photos) ? body.photos : [];

  if (!agentNumber) return sendJson(res, 400, { error: "agentNumber is required." });
  if (!photos.length) return sendJson(res, 400, { error: "photos array is required." });
  if (!isWatchedPhone(agentNumber)) return sendJson(res, 200, { ignored: true, nextMessage: "" });

  const rooms = [];
  for (let i = 0; i < photos.length; i += 1) {
    const photo = photos[i];
    const bytes = Buffer.from(String(photo.base64 || ""), "base64");
    if (!bytes.length) continue;
    const fileName = photo.fileName || `whatsapp-photo-${i + 1}.jpg`;
    const mime = photo.mime || "image/jpeg";
    const file = new File([bytes], fileName, { type: mime });
    const saved = await saveUpload(file, "whatsapp", agentNumber, projectName);
    const room = await analyzeRoom(file, i + 1, recommendedPrompt, roomHints[i] || "");
    rooms.push({
      ...room,
      agentNumber,
      projectName,
      sourceUrl: saved.url,
      sourcePath: saved.path,
      sourceMime: mime
    });
  }

  const job = createJob({ agentNumber, projectName, rooms, status: "AWAITING_RESPONSES" });
  sendJson(res, 200, {
    job: publicJob(job),
    rooms,
    nextMessage: rooms.map(room => {
      const questions = room.questions.map((q, index) => `${index + 1}. ${q}`).join("\n");
      return `Photo ${room.index} - ${room.room}\nCurrent state: ${room.condition}\n\n${questions}`;
    }).join("\n\n---\n\n")
  });
}

async function handleWhatsAppText(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const agentNumber = String(body.agentNumber || body.phone || "");
  const text = String(body.text || "");
  if (!agentNumber || !isWatchedPhone(agentNumber)) return sendJson(res, 200, { ignored: true, reply: "" });

  const lower = text.toLowerCase();
  const shouldReply = ["stage", "staging", "property", "listing", "photo", "photos", "room"].some(word => lower.includes(word));
  sendJson(res, 200, {
    reply: shouldReply
      ? "Hi, this is StageMyHome. Send me the room photos here and I’ll analyse each space before staging."
      : ""
  });
}

async function generateVariant(room, sourcePath, prompt, variant) {
  if (!openAIKey) {
    return {
      id: crypto.randomUUID(),
      variant,
      url: room.sourceUrl,
      mock: true
    };
  }

  const form = new FormData();
  const imageBlob = new Blob([await readFile(sourcePath)], { type: room.sourceMime || "image/jpeg" });
  form.append("model", imageModel);
  form.append("image", imageBlob, path.basename(sourcePath));
  form.append("prompt", buildStagingPrompt(room.room, room.features, prompt));
  form.append("n", "1");
  form.append("size", "1536x1024");
  form.append("quality", "high");
  form.append("input_fidelity", "high");
  form.append("output_format", "jpeg");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${openAIKey}` },
    body: form
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Image generation failed: ${response.status} ${detail}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error("Image generation returned no image payload.");

  const fileName = `generated_${crypto.randomUUID()}_${safeName(room.room)}_${variant}.jpg`;
  const target = path.join(generatedDir, fileName);
  await writeFile(target, Buffer.from(b64, "base64"));
  return { id: crypto.randomUUID(), variant, url: `/generated/${fileName}` };
}

async function handleGenerate(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const job = body.jobId ? jobs.get(body.jobId) : null;
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  const variantsPerRoom = Math.max(1, Math.min(Number(body.variantsPerRoom || 1), 2));

  if (!rooms.length) return sendJson(res, 400, { error: "No analyzed rooms supplied." });

  if (job) saveJob({ ...job, status: "GENERATING" });

  const generated = [];
  for (const room of rooms) {
    const roomImages = [];
    const sourcePath = room.sourcePath;
    if (!sourcePath || !existsSync(sourcePath)) throw new Error(`Missing source image for ${room.room}.`);
    const prompt =
      room.finalPrompt ||
      room.suggestedPrompt ||
      `Stage this ${room.room} for a premium real estate listing. Preserve geometry and natural light.`;
    for (let variant = 1; variant <= variantsPerRoom; variant += 1) {
      roomImages.push(await generateVariant(room, sourcePath, prompt, variant));
    }
    generated.push({ roomId: room.id, images: roomImages });
  }

  if (job) {
    const generatedMap = Object.fromEntries(generated.map(item => [item.roomId, item.images]));
    saveJob({ ...jobs.get(job.id), status: "AWAITING_CURATION", generated: generatedMap });
  }

  sendJson(res, 200, { generated, job: job ? publicJob(jobs.get(job.id)) : null });
}

async function handleCompile(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const job = body.jobId ? jobs.get(body.jobId) : null;
  const agentNumber = body.agentNumber || "65XXXXXXXX";
  const projectName = body.projectName || "StageMyHome Project";
  const count = Array.isArray(body.selected) ? body.selected.length : 0;
  const selected = Array.isArray(body.selected) ? body.selected : [];
  const folderName = `StageMyHome_${safeName(agentNumber)}_${safeName(projectName)}_${new Date().toISOString().slice(0, 10)}`;
  const fakeLink = `http://localhost:${PORT}/delivery/${job?.id || safeName(folderName)}`;
  const driveLink = googleTokens?.access_token ? await uploadSelectionToDrive(folderName, selected, body.rooms || []) : fakeLink;
  if (job) {
    saveJob({
      ...job,
      status: "COMPLETE",
      selected: Object.fromEntries(selected.map(item => [item.roomId, item.image])),
      driveLink
    });
  }

  const whatsappMessage = `Your StageMyHome images are ready! Download here: ${driveLink}\n\n${count} rooms, staged for your listing. Let us know if you'd like adjustments.`;
  if (job?.agentNumber) await sendViaWhatsApp(job.agentNumber, whatsappMessage);

  sendJson(res, 200, {
    folderName,
    count,
    driveLink,
    whatsappMessage
  });
}

async function sendViaWhatsApp(agentNumber, message) {
  try {
    await fetch(`${bridgeURL.replace(/\/$/, "")}/api/send`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recipient: normalizePhone(agentNumber), message })
    });
  } catch (error) {
    console.warn("WhatsApp send skipped:", error.message);
  }
}

async function handleJobs(_req, res) {
  const list = [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicJob);
  sendJson(res, 200, { jobs: list });
}

async function handleDemoConfig(req, res) {
  if (req.method === "GET") {
    return sendJson(res, 200, { watchPhone, bridgeURL, hasOpenAIKey: Boolean(openAIKey) });
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (typeof body.watchPhone === "string") watchPhone = body.watchPhone;
  if (typeof body.bridgeURL === "string" && body.bridgeURL.trim()) bridgeURL = body.bridgeURL.trim();
  if (typeof body.openAIKey === "string" && body.openAIKey.trim()) openAIKey = body.openAIKey.trim();
  sendJson(res, 200, { watchPhone, bridgeURL, hasOpenAIKey: Boolean(openAIKey) });
}

async function handleJobAction(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const job = jobs.get(body.jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found." });

  if (body.action === "agent_confirmed") job.status = "PENDING_PAYMENT";
  if (body.action === "verify_payment") job.status = "PAYMENT_VERIFIED";
  if (body.action === "awaiting_curation") job.status = "AWAITING_CURATION";
  if (body.action === "rerun") job.status = "PAYMENT_VERIFIED";
  if (body.action === "complete") job.status = "COMPLETE";

  saveJob(job);
  sendJson(res, 200, { job: publicJob(job) });
}

function resolveLocalAsset(urlPath) {
  const decoded = decodeURIComponent(String(urlPath || ""));
  if (decoded.startsWith("/generated/")) return path.join(generatedDir, decoded.replace("/generated/", ""));
  if (decoded.startsWith("/uploads/")) return path.join(uploadsDir, decoded.replace("/uploads/", ""));
  return "";
}

async function googleFetch(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      authorization: `Bearer ${googleTokens.access_token}`
    }
  });
  if (response.status !== 401) return response;
  throw new Error("Google token expired. Reconnect Google Drive from Settings.");
}

async function uploadSelectionToDrive(folderName, selected, rooms) {
  const folderRes = await googleFetch("https://www.googleapis.com/drive/v3/files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: folderName, mimeType: "application/vnd.google-apps.folder" })
  });
  if (!folderRes.ok) throw new Error(`Drive folder creation failed: ${await folderRes.text()}`);
  const folder = await folderRes.json();

  for (let i = 0; i < selected.length; i += 1) {
    const item = selected[i];
    const room = rooms.find(candidate => candidate.id === item.roomId);
    const localPath = resolveLocalAsset(item.image?.url);
    if (!localPath || !existsSync(localPath)) continue;
    const bytes = await readFile(localPath);
    const metadata = {
      name: `${String(i + 1).padStart(2, "0")}_${safeName(room?.room || "Room")}.jpg`,
      parents: [folder.id]
    };
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
    form.append("file", new Blob([bytes], { type: "image/jpeg" }), metadata.name);
    const uploadRes = await googleFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
      method: "POST",
      body: form
    });
    if (!uploadRes.ok) throw new Error(`Drive upload failed: ${await uploadRes.text()}`);
  }

  const permissionRes = await googleFetch(`https://www.googleapis.com/drive/v3/files/${folder.id}/permissions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role: "reader", type: "anyone" })
  });
  if (!permissionRes.ok) throw new Error(`Drive sharing failed: ${await permissionRes.text()}`);

  const linkRes = await googleFetch(`https://www.googleapis.com/drive/v3/files/${folder.id}?fields=webViewLink`);
  if (!linkRes.ok) throw new Error(`Drive link lookup failed: ${await linkRes.text()}`);
  const link = await linkRes.json();
  return link.webViewLink || "";
}

async function handleSettings(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (typeof body.openAIKey === "string" && body.openAIKey.trim()) openAIKey = body.openAIKey.trim();
  if (typeof body.analysisModel === "string" && body.analysisModel.trim()) analysisModel = body.analysisModel.trim();
  if (typeof body.imageModel === "string" && body.imageModel.trim()) imageModel = body.imageModel.trim();
  if (typeof body.googleClientId === "string") googleClientId = body.googleClientId.trim() || googleClientId;
  if (typeof body.googleClientSecret === "string") googleClientSecret = body.googleClientSecret.trim() || googleClientSecret;
  if (typeof body.googleRedirectUri === "string") googleRedirectUri = body.googleRedirectUri.trim() || googleRedirectUri;
  sendJson(res, 200, {
    hasOpenAIKey: Boolean(openAIKey),
    analysisModel,
    imageModel,
    hasGoogleClient: Boolean(googleClientId && googleClientSecret),
    googleRedirectUri,
    googleConnected: Boolean(googleTokens?.access_token)
  });
}

function handleGoogleStart(_req, res) {
  if (!googleClientId || !googleClientSecret) {
    res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    res.end("Set Google Client ID and Client Secret in StageMyHome Settings first.");
    return;
  }
  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: googleRedirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/drive.file",
    access_type: "offline",
    prompt: "consent"
  });
  res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  res.end();
}

async function handleGoogleCallback(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const code = url.searchParams.get("code");
  if (!code) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`
      <h1>Google OAuth callback</h1>
      <p>This address is not meant to be opened directly.</p>
      <p>Return to StageMyHome, open Settings, paste your Google OAuth credentials, then click <strong>Save + Connect Google Drive</strong>.</p>
      <p>In Google Cloud, add this redirect URI exactly: <code>${googleRedirectUri}</code></p>
    `);
    return;
  }
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: googleRedirectUri,
      grant_type: "authorization_code"
    })
  });
  if (!tokenRes.ok) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(`Google OAuth token exchange failed: ${await tokenRes.text()}`);
    return;
  }
  googleTokens = await tokenRes.json();
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end("<h1>Google Drive connected</h1><p>You can return to StageMyHome and compile the delivery.</p>");
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/delivery/")) return serveDelivery(url.pathname.split("/").pop(), res);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  let baseDir = publicDir;
  if (pathname.startsWith("/uploads/")) baseDir = uploadsDir;
  if (pathname.startsWith("/generated/")) baseDir = generatedDir;

  const relative = pathname.replace(/^\/(uploads|generated)\//, "").replace(/^\//, "");
  const target = path.normalize(path.join(baseDir, relative));
  if (!target.startsWith(baseDir)) return sendJson(res, 403, { error: "Forbidden" });

  try {
    await stat(target);
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { "content-type": mimeByExt[ext] || "application/octet-stream" });
    const stream = createReadStream(target);
    stream.on("error", () => {
      if (!res.headersSent) sendJson(res, 404, { error: "Not found" });
      else res.end();
    });
    stream.pipe(res);
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}

function serveDelivery(jobId, res) {
  const job = jobs.get(jobId);
  const images = job ? Object.values(job.selected || {}) : [];
  const body = `<!doctype html>
    <html><head><title>StageMyHome Delivery</title><style>
    body{font-family:Arial,sans-serif;margin:32px;background:#fbfdfc;color:#18211f}
    h1{margin-bottom:4px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px;margin-top:24px}
    img{width:100%;border-radius:8px;border:1px solid #d9e2de}
    </style></head><body>
    <h1>StageMyHome Delivery</h1>
    <p>${job ? `${job.projectName} · ${images.length} images` : "Demo delivery link"}</p>
    <div class="grid">${images.map(image => `<a href="${image.url}" download><img src="${image.url}" /></a>`).join("")}</div>
    </body></html>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/config") {
      return sendJson(res, 200, {
        hasOpenAIKey: Boolean(openAIKey),
        analysisModel,
        imageModel,
        hasGoogleClient: Boolean(googleClientId && googleClientSecret),
        googleRedirectUri,
        googleConnected: Boolean(googleTokens?.access_token)
      });
    }
    if (req.method === "POST" && req.url === "/api/settings") return await handleSettings(req, res);
    if (req.method === "GET" && req.url === "/api/jobs") return await handleJobs(req, res);
    if (req.url === "/api/demo-config") return await handleDemoConfig(req, res);
    if (req.method === "POST" && req.url === "/api/job-action") return await handleJobAction(req, res);
    if (req.method === "POST" && req.url === "/api/whatsapp/inbound") return await handleWhatsAppInbound(req, res);
    if (req.method === "POST" && req.url === "/api/whatsapp/text") return await handleWhatsAppText(req, res);
    if (req.method === "GET" && req.url === "/oauth/google/start") return handleGoogleStart(req, res);
    if (req.method === "GET" && req.url.startsWith("/oauth/google/callback")) return await handleGoogleCallback(req, res);
    if (req.method === "POST" && req.url === "/api/analyze") return await handleAnalyze(req, res);
    if (req.method === "POST" && req.url === "/api/generate") return await handleGenerate(req, res);
    if (req.method === "POST" && req.url === "/api/compile") return await handleCompile(req, res);
    return await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
});

server.listen(PORT, () => {
  console.log(`StageMyHome running at http://localhost:${PORT}`);
});

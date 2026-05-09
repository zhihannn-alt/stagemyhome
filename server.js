import http from "node:http";
import { readFile, mkdir, writeFile, stat } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const runtimeDir = process.env.VERCEL ? "/tmp/stagemyhome" : __dirname;
const uploadsDir = path.join(runtimeDir, "uploads");
const generatedDir = path.join(runtimeDir, "generated");

await loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 5173);
let openAIKey = process.env.OPENAI_API_KEY || "";
let openAIImageKey = process.env.OPENAI_IMAGE_API_KEY || "";
let analysisModel = process.env.OPENAI_ANALYSIS_MODEL || "gpt-5.5";
let imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
let googleClientId = process.env.GOOGLE_CLIENT_ID || "";
let googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
let googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${PORT}/oauth/google/callback`;
let googleTokens = null;
let watchPhone = process.env.DEMO_WATCH_PHONE || "";
let bridgeURL = process.env.WHATSAPP_BRIDGE_URL || "http://localhost:8080";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;
if (!supabase) console.warn("Supabase not configured — jobs stored in memory only (lost on restart).");

const appUrl = process.env.APP_URL
  || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
  || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null)
  || `http://localhost:${process.env.PORT || 5173}`;

// In-memory fallback used when Supabase is not configured.
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
    agentNotes: job.agentNotes || "",
    agentJID: job.agentJID || "",
    responseIndex: job.responseIndex || 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function dbToJob(row, rooms) {
  return {
    id: row.id,
    agentNumber: row.agent_number,
    projectName: row.project_name,
    status: row.status,
    driveLink: row.delivery_link || "",
    generated: row.generated_data || {},
    selected: row.selected_data || {},
    agentNotes: row.agent_notes || "",
    agentJID: row.reply_jid || "",
    pendingWhatsappMessage: row.pending_whatsapp_message || "",
    responseIndex: row.response_index || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    rooms: (rooms || []).map(r => ({
      id: r.id,
      index: r.room_index,
      room: r.room,
      condition: r.condition,
      features: r.features || [],
      questions: r.questions || [],
      suggestedPrompt: r.suggested_prompt || "",
      finalPrompt: r.final_prompt || null,
      sourceUrl: r.source_url,
      sourcePath: r.source_path,
      sourceMime: r.source_mime || "image/jpeg",
      agentNumber: row.agent_number,
      projectName: row.project_name
    }))
  };
}

async function loadJob(id) {
  if (supabase) {
    const { data: row, error } = await supabase.from("jobs").select("*").eq("id", id).single();
    if (error || !row) return jobs.get(id) || null;
    const { data: rooms } = await supabase.from("rooms").select("*").eq("job_id", id).order("room_index");
    const job = dbToJob(row, rooms || []);
    jobs.set(id, job);
    return job;
  }
  return jobs.get(id) || null;
}

async function loadAllJobs() {
  if (supabase) {
    const { data: rows, error } = await supabase
      .from("jobs")
      .select("*")
      .order("created_at", { ascending: false });
    if (error || !rows?.length) return [];
    const ids = rows.map(r => r.id);
    const { data: allRooms } = await supabase
      .from("rooms")
      .select("*")
      .in("job_id", ids)
      .order("room_index");
    return rows.map(row => {
      const rooms = (allRooms || []).filter(r => r.job_id === row.id);
      return dbToJob(row, rooms);
    });
  }
  return [...jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function saveJob(job) {
  job.updatedAt = new Date().toISOString();
  jobs.set(job.id, job);

  if (supabase) {
    const { error: jobErr } = await supabase.from("jobs").upsert({
      id: job.id,
      agent_number: job.agentNumber,
      project_name: job.projectName,
      status: job.status,
      delivery_link: job.driveLink || null,
      generated_data: job.generated || {},
      selected_data: job.selected || {},
      agent_notes: job.agentNotes || null,
      reply_jid: job.agentJID || null,
      pending_whatsapp_message: job.pendingWhatsappMessage || null,
      response_index: job.responseIndex || 0,
      created_at: job.createdAt,
      updated_at: job.updatedAt
    });
    if (jobErr) console.error("Supabase job upsert error:", jobErr.message);

    if (job.rooms?.length) {
      const { error: roomErr } = await supabase.from("rooms").upsert(
        job.rooms.map(r => ({
          id: r.id,
          job_id: job.id,
          room_index: r.index,
          room: r.room,
          condition: r.condition,
          features: r.features || [],
          questions: r.questions || [],
          suggested_prompt: r.suggestedPrompt || "",
          final_prompt: r.finalPrompt || null,
          source_path: r.sourcePath || null,
          source_url: r.sourceUrl || null,
          source_mime: r.sourceMime || "image/jpeg"
        }))
      );
      if (roomErr) console.error("Supabase rooms upsert error:", roomErr.message);
    }
  }

  return job;
}

async function createJob({ agentNumber, projectName, rooms, status = "AWAITING_RESPONSES", agentJID = "" }) {
  return saveJob({
    id: crypto.randomUUID(),
    agentNumber,
    projectName,
    rooms,
    status,
    generated: {},
    selected: {},
    driveLink: "",
    agentNotes: "",
    agentJID,
    pendingWhatsappMessage: "",
    responseIndex: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
}

async function uploadToStorage(buffer, storagePath, mimeType) {
  if (!supabase) return null;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "stagemyhome";
  const { error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, { contentType: mimeType, upsert: true });
  if (error) {
    console.error("Supabase storage upload error:", error.message);
    return null;
  }
  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data.publicUrl;
}

async function ensureLocalFile(localPath, publicUrl) {
  if (existsSync(localPath)) return;
  if (!publicUrl) throw new Error(`Source file missing locally and no storage URL available.`);
  const res = await fetch(publicUrl);
  if (!res.ok) throw new Error(`Failed to download source image from storage: ${res.status}`);
  await mkdir(path.dirname(localPath), { recursive: true });
  await writeFile(localPath, Buffer.from(await res.arrayBuffer()));
}

async function findOpenJobForSender(agentNumber) {
  if (supabase) {
    const { data } = await supabase
      .from("jobs")
      .select("id")
      .eq("agent_number", agentNumber)
      .eq("status", "AWAITING_RESPONSES")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return loadJob(data.id);
  }
  const matching = [...jobs.values()]
    .filter(j => j.agentNumber === agentNumber && j.status === "AWAITING_RESPONSES")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return matching[0] || null;
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
  const subdir = `${normalizePhone(agentNumber)}/${safeSegment(projectName, "default-project")}`;
  const folder = path.join(uploadsDir, subdir);
  await mkdir(folder, { recursive: true });
  const name = `${prefix}_${crypto.randomUUID()}_${safeName(file.name || `photo${ext}`)}`;
  const target = path.join(folder, name);
  const buffer = Buffer.from(await file.arrayBuffer());
  await writeFile(target, buffer);
  const storageUrl = await uploadToStorage(buffer, `uploads/${subdir}/${name}`, file.type || "image/jpeg");
  return {
    path: target,
    url: storageUrl || `/uploads/${subdir}/${name}`
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
  const job = await createJob({ agentNumber, projectName, rooms, status: "AWAITING_RESPONSES" });
  sendJson(res, 200, { job: publicJob(job), rooms });
}

function roomQuestionMessage(room, roomNumber, totalRooms) {
  const questions = room.questions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const header = totalRooms > 1
    ? `Photo ${roomNumber} of ${totalRooms} – ${room.room} (${room.condition})`
    : `Photo – ${room.room} (${room.condition})`;
  return `${header}\n\n${questions}`;
}

async function handleWhatsAppInbound(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const agentNumber = String(body.agentNumber || body.phone || "");
  const replyJID = String(body.replyJID || "");
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

  const job = await createJob({ agentNumber, projectName, rooms, status: "AWAITING_RESPONSES", agentJID: replyJID });
  sendJson(res, 200, {
    job: publicJob(job),
    rooms,
    nextMessage: roomQuestionMessage(rooms[0], 1, rooms.length)
  });
}

async function handleWhatsAppText(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const agentNumber = String(body.agentNumber || body.phone || "");
  const text = String(body.text || "").trim();
  if (!agentNumber || !isWatchedPhone(agentNumber)) return sendJson(res, 200, { ignored: true, reply: "" });

  // Link text reply to the most recent open job for this sender, room by room in order
  if (text) {
    const openJob = await findOpenJobForSender(agentNumber);
    if (openJob) {
      const idx = openJob.responseIndex || 0;
      const targetRoom = openJob.rooms[idx];
      if (targetRoom) {
        const updatedRooms = openJob.rooms.map((room, i) =>
          i === idx ? { ...room, suggestedPrompt: buildStagingPrompt(room.room, room.features, text) } : room
        );
        const nextIdx = idx + 1;
        const allDone = nextIdx >= openJob.rooms.length;
        const notesEntry = `${targetRoom.room}: ${text}`;
        await saveJob({
          ...openJob,
          rooms: updatedRooms,
          agentNotes: openJob.agentNotes ? `${openJob.agentNotes} | ${notesEntry}` : notesEntry,
          responseIndex: nextIdx,
          status: allDone ? "AGENT_RESPONDED" : "AWAITING_RESPONSES"
        });
        if (allDone) {
          sendJson(res, 200, { reply: `Got it for the ${targetRoom.room}! All preferences noted — your operator will generate the staged images shortly.` });
        } else {
          const nextRoom = openJob.rooms[nextIdx];
          const nextQ = roomQuestionMessage(nextRoom, nextIdx + 1, openJob.rooms.length);
          sendJson(res, 200, { reply: `Got it for the ${targetRoom.room}!\n\n${nextQ}` });
        }
        return;
      }
    }
  }

  const lower = text.toLowerCase();
  const shouldReply = ["stage", "staging", "property", "listing", "photo", "photos", "room"].some(word => lower.includes(word));
  sendJson(res, 200, {
    reply: shouldReply
      ? "Hi, this is StageMyHome. Send me the room photos here and I’ll analyse each space before staging."
      : ""
  });
}

async function generateVariant(room, sourcePath, prompt, variant) {
  await ensureLocalFile(sourcePath, room.sourceUrl);

  const activeImageKey = openAIImageKey || openAIKey;
  if (!activeImageKey) {
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
  form.append("output_format", "jpeg");

  const response = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { authorization: `Bearer ${activeImageKey}` },
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
  const generatedBuffer = Buffer.from(b64, "base64");
  await writeFile(target, generatedBuffer);
  const storageUrl = await uploadToStorage(generatedBuffer, `generated/${fileName}`, "image/jpeg");
  return { id: crypto.randomUUID(), variant, url: storageUrl || `/generated/${fileName}` };
}

async function handleGenerate(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  let job = body.jobId ? await loadJob(body.jobId) : null;
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  const variantsPerRoom = Math.max(1, Math.min(Number(body.variantsPerRoom || 1), 2));

  if (!rooms.length) return sendJson(res, 400, { error: "No analyzed rooms supplied." });

  if (job) await saveJob({ ...job, status: "GENERATING" });

  const generated = [];
  for (const room of rooms) {
    const roomImages = [];
    const sourcePath = room.sourcePath || path.join(uploadsDir, `missing_${room.id}.jpg`);
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
    const newMap = Object.fromEntries(generated.map(item => [item.roomId, item.images]));
    const mergedGenerated = { ...(job.generated || {}) };
    for (const room of rooms) {
      mergedGenerated[room.id] = [...(mergedGenerated[room.id] || []), ...(newMap[room.id] || [])];
    }
    job = await saveJob({ ...job, status: "AWAITING_CURATION", generated: mergedGenerated });
  }

  sendJson(res, 200, { generated, job: job ? publicJob(job) : null });
}

async function handleCompile(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const job = body.jobId ? await loadJob(body.jobId) : null;
  const agentNumber = body.agentNumber || "65XXXXXXXX";
  const projectName = body.projectName || "StageMyHome Project";
  const count = Array.isArray(body.selected) ? body.selected.length : 0;
  const selected = Array.isArray(body.selected) ? body.selected : [];
  const folderName = `StageMyHome_${safeName(agentNumber)}_${safeName(projectName)}_${new Date().toISOString().slice(0, 10)}`;
  const deliveryLink = googleTokens?.access_token
    ? await uploadSelectionToDrive(folderName, selected, body.rooms || [])
    : `${appUrl}/delivery/${job?.id || safeName(folderName)}`;
  const whatsappMessage = `Your StageMyHome images are ready! Download here: ${deliveryLink}\n\n${count} rooms, staged for your listing. Let us know if you'd like adjustments.`;
  if (job) {
    await saveJob({
      ...job,
      status: "COMPLETE",
      selected: Object.fromEntries(selected.map(item => [item.roomId, item.image])),
      driveLink: deliveryLink,
      pendingWhatsappMessage: job.agentJID ? whatsappMessage : ""
    });
  }

  sendJson(res, 200, {
    folderName,
    count,
    driveLink: deliveryLink,
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

async function handlePendingMessages(_req, res) {
  const list = await loadAllJobs();
  const pending = list
    .filter(job => job.pendingWhatsappMessage && job.agentJID)
    .map(job => {
      const images = Object.entries(job.selected || {}).map(([roomId, img]) => {
        const room = (job.rooms || []).find(r => r.id === roomId);
        return { url: img?.url, room: room?.room || "Room" };
      }).filter(item => item.url);
      return { jobId: job.id, replyJID: job.agentJID, message: job.pendingWhatsappMessage, images };
    });
  for (const item of pending) {
    const job = await loadJob(item.jobId);
    if (job) await saveJob({ ...job, pendingWhatsappMessage: "" });
  }
  sendJson(res, 200, { messages: pending });
}

async function handleJobs(_req, res) {
  const list = (await loadAllJobs()).map(publicJob);
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
  const job = await loadJob(body.jobId);
  if (!job) return sendJson(res, 404, { error: "Job not found." });

  if (body.action === "agent_confirmed") job.status = "PENDING_PAYMENT";
  if (body.action === "verify_payment") job.status = "PAYMENT_VERIFIED";
  if (body.action === "awaiting_curation") job.status = "AWAITING_CURATION";
  if (body.action === "rerun") job.status = "PAYMENT_VERIFIED";
  if (body.action === "complete") job.status = "COMPLETE";

  await saveJob(job);
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
  if (url.pathname.startsWith("/delivery/")) return await serveDelivery(url.pathname.split("/").pop(), res);
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

async function serveDelivery(jobId, res) {
  const job = await loadJob(jobId);
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

export async function handleRequest(req, res) {
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
    if (req.method === "GET" && req.url === "/api/pending-messages") return await handlePendingMessages(req, res);
    if (req.url === "/api/demo-config") return await handleDemoConfig(req, res);
    if (req.method === "POST" && req.url === "/api/job-action") return await handleJobAction(req, res);
    if (req.method === "POST" && req.url === "/api/whatsapp/inbound") return await handleWhatsAppInbound(req, res);
    if (req.method === "POST" && req.url === "/api/whatsapp/text") return await handleWhatsAppText(req, res);
    if (req.method === "GET" && req.url === "/oauth/google/start") return handleGoogleStart(req, res);
    if (req.method === "GET" && req.url.startsWith("/oauth/google/callback")) return await handleGoogleCallback(req, res);
    if (req.method === "POST" && req.url === "/api/analyze") return await handleAnalyze(req, res);
    if (req.method === "POST" && req.url === "/api/generate") return await handleGenerate(req, res);
    if (req.method === "POST" && req.url === "/api/compile") return await handleCompile(req, res);
    if (req.method === "GET" && req.url.startsWith("/api/delivery/")) return serveDelivery(req.url.split("/").pop(), res);
    return await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Unexpected server error" });
  }
}

export default handleRequest;

if (!process.env.VERCEL) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`StageMyHome running at http://localhost:${PORT}`);
  });
}

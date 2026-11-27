function loadGroqKeys() {
  const keys = [];
  if (typeof process.env.GROQ_API_KEY === "string" && process.env.GROQ_API_KEY.trim()) {
    keys.push(process.env.GROQ_API_KEY.trim());
  }

  const numberedKeys = Object.keys(process.env)
    .filter((key) => /^GROQ_API_KEY_\d+$/.test(key))
    .sort((a, b) => {
      const numA = parseInt(a.replace("GROQ_API_KEY_", ""), 10);
      const numB = parseInt(b.replace("GROQ_API_KEY_", ""), 10);
      return numA - numB;
    });

  for (const envName of numberedKeys) {
    const val = process.env[envName];
    if (typeof val === "string" && val.trim() && !keys.includes(val.trim())) {
      keys.push(val.trim());
    }
  }

  return keys;
}

const GROQ_KEYS = loadGroqKeys();
const GEMINI_API_KEY = typeof process.env.GEMINI_API_KEY === "string" ? process.env.GEMINI_API_KEY.trim() : "";

const DEFAULT_AUTO_MODEL = "llama-3.1-8b-instant";
const FALLBACK_MODELS = [
  "llama-3.1-8b-instant",
  "openai/gpt-oss-20b",
  "qwen/qwen3-32b",
  "moonshotai/kimi-k2-instruct-0905",
  "llama-3.3-70b-versatile",
  "openai/gpt-oss-120b"
];

const SHORT_CLEAR_SYSTEM_PROMPT =
  "أنت مساعد ذكي باسم My AI مطور من قبل NC Studio. أجب بنفس لغة المستخدم بوضوح واختصار شديد. " +
  "اجعل الرد ملخصاً ومباشراً ومناسباً للقراءة السريعة على الشاشة، وتجنب الإطالة أو الحشو أو الرموز الزائدة مثل --- و ## و **. " +
  "احرص دائماً على إنهاء جملك ونقاطك بشكل كامل وغير مقطوع.";

const MAX_RETRIES_PER_KEY = 1;
const RETRY_DELAYS_MS = [1000, 2000];
let roundRobinIndex = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOrderedKeys() {
  if (!GROQ_KEYS.length) return [];
  const start = roundRobinIndex % GROQ_KEYS.length;
  roundRobinIndex = (roundRobinIndex + 1) % GROQ_KEYS.length;

  const ordered = [];
  for (let i = 0; i < GROQ_KEYS.length; i++) {
    ordered.push(GROQ_KEYS[(start + i) % GROQ_KEYS.length]);
  }
  return ordered;
}

function sanitizeModel(model) {
  if (!model || typeof model !== "string" || model === "auto") {
    return DEFAULT_AUTO_MODEL;
  }
  const clean = model.trim();
  return clean || DEFAULT_AUTO_MODEL;
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
}

async function analyzeVisualWithGemini(promptText, framesList) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      error: "لتحليل الصور والفيديو فعلياً، أضف مفتاح GEMINI_API_KEY المجاني في إعدادات Vercel."
    };
  }

  const parts = [{ text: promptText }];
  for (const frame of framesList.slice(0, 4)) {
    const parsed = parseDataUrl(frame);
    if (parsed) {
      parts.push({
        inline_data: {
          mime_type: parsed.mimeType,
          data: parsed.base64Data
        }
      });
    }
  }

  const modelsToTry = [
    "gemini-4-argon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-2.5-flash"
  ];

  for (const gemModel of modelsToTry) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${gemModel}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: SHORT_CLEAR_SYSTEM_PROMPT }]
          },
          contents: [{ role: "user", parts }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 750
          }
        })
      });

      const data = await response.json().catch(() => ({}));
      const replyText = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
      if (response.ok && replyText) {
        return {
          ok: true,
          model: gemModel,
          replyText
        };
      }
    } catch (e) {}
  }

  return {
    ok: false,
    error: "تعذر تحليل الصورة حالياً؛ تأكد من صلاحية GEMINI_API_KEY."
  };
}

function buildGroqMessages(messages) {
  const rawList = Array.isArray(messages) ? messages : [];
  const filtered = rawList.filter((m) => m && m.role !== "system");
  const safeMessages = filtered.slice(-2).map((m) => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: typeof m.content === "string" ? m.content.slice(0, 1200) : String(m.content || "")
  }));
  return [{ role: "system", content: SHORT_CLEAR_SYSTEM_PROMPT }, ...safeMessages];
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { messages, model, hasImage, imageBase64, videoFrames } = req.body || {};
    const framesList = Array.isArray(videoFrames) && videoFrames.length
      ? videoFrames.slice(0, 4)
      : (imageBase64 ? [imageBase64] : []);

    const hasVisualInput = Boolean(hasImage && framesList.length > 0);

    if (hasVisualInput) {
      const lastUserMsg = Array.isArray(messages)
        ? [...messages].reverse().find((m) => m && m.role === "user")
        : null;
      const promptText =
        typeof lastUserMsg?.content === "string" && lastUserMsg.content.trim()
          ? lastUserMsg.content.trim()
          : "لخّص واشرح هذا المحتوى المرئي بوضوح واختصار.";

      const visionResult = await analyzeVisualWithGemini(promptText, framesList);
      if (visionResult.ok) {
        return res.status(200).json({
          choices: [{ message: { role: "assistant", content: visionResult.replyText } }],
          served_by_model: visionResult.model
        });
      }
      return res.status(503).json({ error: visionResult.error });
    }

    if (!GROQ_KEYS.length) {
      return res.status(500).json({ error: "No Groq API keys configured on server" });
    }

    const chosenModel = sanitizeModel(model);
    const candidateModels = [chosenModel, ...FALLBACK_MODELS.filter((m) => m !== chosenModel)];
    const groqMessages = buildGroqMessages(messages);
    const keysToTry = getOrderedKeys();

    let lastErrorData = { error: "الضغط مرتفع حالياً، يرجى المحاولة بعد قليل." };
    let lastStatus = 502;

    for (const modelName of candidateModels) {
      for (let i = 0; i < keysToTry.length; i++) {
        const apiKey = keysToTry[i];

        for (let retry = 0; retry <= MAX_RETRIES_PER_KEY; retry++) {
          try {
            const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`
              },
              body: JSON.stringify({
                model: modelName,
                messages: groqMessages,
                max_tokens: 750,
                temperature: 0.5
              })
            });

            const data = await response.json().catch(() => ({}));

            if (response.ok && data?.choices?.length > 0) {
              return res.status(200).json({
                ...data,
                served_by_model: modelName
              });
            }

            lastStatus = response.status;
            lastErrorData =
              response.status === 429
                ? { error: "الضغط مرتفع حالياً، جاري التبديل إلى نموذج بديل..." }
                : data;

            const errMsg = String(data?.error?.message || data?.error || "").toLowerCase();
            const isModelError =
              response.status === 404 ||
              errMsg.includes("does not exist") ||
              errMsg.includes("do not have access") ||
              errMsg.includes("decommissioned") ||
              errMsg.includes("model");

            if (isModelError) {
              break;
            }

            const isTransient = response.status === 429 || response.status === 413 || response.status >= 500;
            if (isTransient && retry < MAX_RETRIES_PER_KEY) {
              await sleep(RETRY_DELAYS_MS[retry] || 1000);
              continue;
            }

            if (isTransient) {
              if (i < keysToTry.length - 1) {
                await sleep(150);
              }
              break;
            }

            return res.status(lastStatus).json(lastErrorData);
          } catch (fetchErr) {
            lastStatus = 502;
            lastErrorData = { error: "حدث خلل مؤقت في الشبكة، يرجى المحاولة مرة أخرى." };
            if (retry < MAX_RETRIES_PER_KEY) {
              await sleep(RETRY_DELAYS_MS[retry] || 1000);
              continue;
            }
            if (i < keysToTry.length - 1) {
              await sleep(150);
            }
            break;
          }
        }
      }
    }

    return res.status(lastStatus).json(lastErrorData);
  } catch (err) {
    console.error("My AI /api/chat error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
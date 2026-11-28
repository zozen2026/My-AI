const GEMINI_API_KEY =
  typeof process.env.GEMINI_API_KEY === "string" ? process.env.GEMINI_API_KEY.trim() : "";

const ALLOWED_MODELS = [
  "gemini-3.8-flash",
  "gemini-2.5-flash",
  "gemini-2.5-pro"
];

const DEFAULT_AUTO_MODEL = "gemini-3.8-flash";

const SHORT_CLEAR_SYSTEM_PROMPT =
  "أنت مساعد ذكي باسم My AI مطور من قبل NC Studio. أجب بنفس لغة المستخدم بوضوح واختصار شديد. " +
  "اجعل الرد ملخصاً ومباشراً ومناسباً للقراءة السريعة على الشاشة، وتجنب الإطالة أو الحشو أو الرموز الزائدة مثل --- و ## و **. " +
  "إذا كانت الإجابة طويلة أو تتضمن عدة نقاط أو محاور، افصل بين النقاط أو المحاور الرئيسية بالسطر الفاصل التالي مع ترك سطر فارغ قبله وسطر فارغ بعده:\n\n" +
  "________________________\n\n" +
  "احرص دائماً على إنهاء جملك ونقاطك بشكل كامل وغير مقطوع.";

const MAX_RETRIES = 1;
const RETRY_DELAYS_MS = [350, 800];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSystemPrompt(userName) {
  const cleanName = typeof userName === "string" ? userName.trim().slice(0, 40) : "";
  if (!cleanName || cleanName === "Guest") {
    return SHORT_CLEAR_SYSTEM_PROMPT;
  }
  return (
    SHORT_CLEAR_SYSTEM_PROMPT +
    ` اسم المستخدم الحالي هو "${cleanName}"؛ نادِهِ به بشكل طبيعي ومناسب عند الترحيب أو الحاجة.`
  );
}

function normalizeLongAnswerSeparators(text) {
  if (typeof text !== "string" || !text.trim()) return text;

  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const hasMultipleBlocks =
    lines.filter((l) => l.trim().length > 0).length >= 4 || text.length >= 300;

  if (!hasMultipleBlocks) {
    return text.trim();
  }

  let formatted = text
    .replace(/\r\n/g, "\n")
    .replace(/\n?\s*_{6,}\s*\n?/g, "\n\n________________________\n\n");

  const separator = "________________________";
  const parts = formatted.split(separator);
  if (parts.length > 1) {
    formatted = parts
      .map((part) => part.replace(/^\n+|\n+$/g, ""))
      .join(`\n\n${separator}\n\n`)
      .trim();
  }

  return formatted.replace(/\n{4,}/g, "\n\n\n").trim();
}

function resolveModelList(requestedModel) {
  if (!requestedModel || typeof requestedModel !== "string" || requestedModel.trim() === "auto") {
    return [DEFAULT_AUTO_MODEL, ...ALLOWED_MODELS.filter((m) => m !== DEFAULT_AUTO_MODEL)];
  }

  const clean = requestedModel.trim().replace(/^models\//, "");
  if (ALLOWED_MODELS.includes(clean)) {
    return [clean, ...ALLOWED_MODELS.filter((m) => m !== clean)];
  }

  return [DEFAULT_AUTO_MODEL, ...ALLOWED_MODELS.filter((m) => m !== DEFAULT_AUTO_MODEL)];
}

function parseDataUrl(dataUrl) {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(String(dataUrl || ""));
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
}

// تحويل سجل الرسائل إلى صيغة Interactions API مع الإبقاء على آخر رسالتين فقط
function buildInteractionInput(messages, framesList) {
  const rawList = Array.isArray(messages) ? messages : [];
  const filtered = rawList.filter(
    (m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim()
  );

  const recentTwo = filtered.slice(-2);

  if (recentTwo.length === 0) {
    const defaultContent = [{ type: "text", text: "لخّص واشرح هذا المحتوى المرئي بوضوح واختصار." }];
    for (const frame of framesList) {
      const parsed = parseDataUrl(frame);
      if (parsed) {
        defaultContent.push({
          type: "image",
          data: parsed.base64Data,
          mime_type: parsed.mimeType
        });
      }
    }
    return [{ role: "user", content: defaultContent }];
  }

  return recentTwo.map((m, idx) => {
    const isLastMessage = idx === recentTwo.length - 1;
    const role = m.role === "assistant" ? "model" : "user";
    const textContent =
      typeof m.content === "string"
        ? m.content.trim().slice(0, 1000)
        : String(m.content || "").trim().slice(0, 1000);

    const content = [{ type: "text", text: textContent }];

    if (isLastMessage && role === "user" && framesList.length > 0) {
      for (const frame of framesList) {
        const parsed = parseDataUrl(frame);
        if (parsed) {
          content.push({
            type: "image",
            data: parsed.base64Data,
            mime_type: parsed.mimeType
          });
        }
      }
    }

    return { role, content };
  });
}

function extractInteractionText(data) {
  if (!data || typeof data !== "object") return "";
  const outputs = Array.isArray(data.outputs) ? data.outputs : [];
  const texts = [];
  for (const item of outputs) {
    if (item && item.type === "text" && typeof item.text === "string") {
      texts.push(item.text);
    } else if (typeof item?.text === "string") {
      texts.push(item.text);
    }
  }
  if (texts.length > 0) return texts.join("").trim();
  if (typeof data.output_text === "string") return data.output_text.trim();
  return "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!GEMINI_API_KEY) {
    return res.status(500).json({
      error: "مفتاح GEMINI_API_KEY غير مضبوط في إعدادات الخادم (Vercel)."
    });
  }

  try {
    const { messages, model, userName, hasImage, imageBase64, videoFrames } = req.body || {};
    const activeSystemPrompt = buildSystemPrompt(userName);

    const framesList =
      Array.isArray(videoFrames) && videoFrames.length
        ? videoFrames.slice(0, 2)
        : imageBase64
        ? [imageBase64]
        : [];

    const hasVisualInput = Boolean(hasImage && framesList.length > 0);
    const candidateModels = resolveModelList(model);
    const input = buildInteractionInput(messages, hasVisualInput ? framesList : []);

    let lastErrorData = { error: "الضغط مرتفع حالياً على Gemini، يرجى المحاولة بعد قليل." };
    let lastStatus = 502;

    for (const gemModel of candidateModels) {
      for (let retry = 0; retry <= MAX_RETRIES; retry++) {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);

        try {
          const url = "https://generativelanguage.googleapis.com/v1beta/interactions";
          const response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": GEMINI_API_KEY
            },
            signal: controller.signal,
            body: JSON.stringify({
              model: `models/${gemModel}`,
              system_instruction: activeSystemPrompt,
              input,
              generation_config: {
                temperature: 0.4,
                max_output_tokens: 2048
              }
            })
          });

          const data = await response.json().catch(() => ({}));
          const rawReplyText = extractInteractionText(data);

          if (response.ok && rawReplyText) {
            const formattedContent = normalizeLongAnswerSeparators(rawReplyText);
            return res.status(200).json({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: formattedContent
                  }
                }
              ],
              served_by_model: gemModel
            });
          }

          lastStatus = response.status;
          const apiMsg = data?.error?.message || "";
          lastErrorData =
            response.status === 429
              ? { error: "تم تجاوز حد الطلبات المؤقت لـ Gemini، جاري التبديل لنموذج بديل..." }
              : { error: apiMsg || "تعذر الحصول على رد من Gemini." };

          const isModelError =
            response.status === 404 ||
            apiMsg.toLowerCase().includes("not found") ||
            apiMsg.toLowerCase().includes("not supported");

          if (isModelError) {
            break;
          }

          const isTransient = response.status === 429 || response.status >= 500;
          if (isTransient && retry < MAX_RETRIES) {
            await sleep(RETRY_DELAYS_MS[retry] || 350);
            continue;
          }

          if (isTransient) {
            break;
          }

          return res.status(lastStatus).json(lastErrorData);
        } catch (fetchErr) {
          lastStatus = 502;
          lastErrorData = { error: "حدث خلل مؤقت في الاتصال بخادم Gemini، يرجى المحاولة مرة أخرى." };
          if (retry < MAX_RETRIES) {
            await sleep(RETRY_DELAYS_MS[retry] || 350);
            continue;
          }
          break;
        } finally {
          clearTimeout(timeoutId);
        }
      }
    }

    return res.status(lastStatus).json(lastErrorData);
  } catch (err) {
    console.error("My AI Gemini /api/chat error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
const GROQ_API_KEY =
  typeof process.env.GROQ_API_KEY === "string" ? process.env.GROQ_API_KEY.trim() : "";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

const ALLOWED_MODELS = [
  "llama-3.1-8b-instant",
  "llama-3.3-70b-versatile"
];

const DEFAULT_AUTO_MODEL = "llama-3.1-8b-instant";

const SHORT_CLEAR_SYSTEM_PROMPT =
  "أنت مساعد ذكي باسم My AI مطور من قبل NC Studio. أجب بنفس لغة المستخدم بوضوح واختصار شديد. " +
  "اجعل الرد ملخصاً ومباشراً ومناسباً للقراءة السريعة على الشاشة، وتجنب الإطالة أو الحشو أو الرموز الزائدة مثل --- و ## و **. " +
  "إذا كانت الإجابة طويلة أو تتضمن عدة نقاط أو محاور، افصل بين النقاط أو المحاور الرئيسية بالسطر الفاصل التالي مع ترك سطر فارغ قبله وسطر فارغ بعده:\n\n" +
  "________________________\n\n" +
  "احرص دائماً على إنهاء جملك ونقاطك بشكل كامل وغير مقطوع.";

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

  const clean = requestedModel.trim();
  if (ALLOWED_MODELS.includes(clean)) {
    return [clean, ...ALLOWED_MODELS.filter((m) => m !== clean)];
  }

  return [DEFAULT_AUTO_MODEL, ...ALLOWED_MODELS.filter((m) => m !== DEFAULT_AUTO_MODEL)];
}

function buildGroqMessages(messages, activeSystemPrompt) {
  const rawList = Array.isArray(messages) ? messages : [];
  const filtered = rawList
    .filter(
      (m) =>
        m &&
        (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string" &&
        m.content.trim()
    )
    .slice(-6)
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, 2000)
    }));

  return [{ role: "system", content: activeSystemPrompt }, ...filtered];
}

function isArabicText(text) {
  return /[\u0600-\u06FF]/.test(String(text || ""));
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!GROQ_API_KEY) {
    return res.status(500).json({
      error: "مفتاح GROQ_API_KEY غير مضبوط في إعدادات الخادم (Vercel)."
    });
  }

  try {
    const { messages, model, userName } = req.body || {};
    const activeSystemPrompt = buildSystemPrompt(userName);
    const candidateModels = resolveModelList(model);
    const groqMessages = buildGroqMessages(messages, activeSystemPrompt);

    const lastUserText =
      [...(Array.isArray(messages) ? messages : [])]
        .reverse()
        .find((m) => m?.role === "user")?.content || "";
    const ar = isArabicText(lastUserText);

    let lastStatus = 503;
    let lastError = ar
      ? "تعذر الحصول على رد من Groq الآن، جرّب الإرسال بعد لحظات."
      : "Unable to get a response from Groq right now. Please try again.";

    for (const groqModel of candidateModels) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 9000);

      try {
        const response = await fetch(GROQ_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GROQ_API_KEY}`
          },
          signal: controller.signal,
          body: JSON.stringify({
            model: groqModel,
            messages: groqMessages,
            temperature: 0.4,
            max_tokens: 2048
          })
        });

        const data = await response.json().catch(() => ({}));
        const rawReplyText =
          typeof data?.choices?.[0]?.message?.content === "string"
            ? data.choices[0].message.content.trim()
            : "";

        if (response.ok && rawReplyText) {
          return res.status(200).json({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: normalizeLongAnswerSeparators(rawReplyText)
                }
              }
            ],
            served_by_model: groqModel
          });
        }

        lastStatus = response.status || 503;
        if (data?.error?.message) {
          lastError = data.error.message;
        }
      } catch {
        lastStatus = 504;
        lastError = ar
          ? "انتهت مهلة الاتصال بخادم Groq، جرّب مرة أخرى."
          : "Connection to Groq timed out. Please try again.";
      } finally {
        clearTimeout(timeoutId);
      }
    }

    return res.status(lastStatus).json({ error: lastError });
  } catch (err) {
    console.error("My AI Groq /api/chat error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
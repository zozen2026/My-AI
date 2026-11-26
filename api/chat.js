const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_API_KEY_2,
  process.env.GROQ_API_KEY_3,
  process.env.GROQ_API_KEY_4,
  process.env.GROQ_API_KEY_5
].filter((key) => typeof key === "string" && key.trim().length > 0);

let roundRobinIndex = 0;

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

function buildGroqMessages(messages, hasImage, imageBase64) {
  const safeMessages = Array.isArray(messages) ? messages.slice() : [];

  if (hasImage && imageBase64) {
    let lastUserIndex = -1;
    for (let i = safeMessages.length - 1; i >= 0; i--) {
      if (safeMessages[i]?.role === "user") {
        lastUserIndex = i;
        break;
      }
    }

    const promptText =
      lastUserIndex >= 0 && typeof safeMessages[lastUserIndex].content === "string"
        ? safeMessages[lastUserIndex].content
        : "Describe and analyze this image in detail.";

    const visionContent = [
      { type: "text", text: promptText },
      {
        type: "image_url",
        image_url: { url: imageBase64 }
      }
    ];

    if (lastUserIndex >= 0) {
      safeMessages[lastUserIndex] = {
        ...safeMessages[lastUserIndex],
        content: visionContent
      };
    } else {
      safeMessages.push({
        role: "user",
        content: visionContent
      });
    }
  }

  return safeMessages;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  if (!GROQ_KEYS.length) {
    return res.status(500).json({ error: "No Groq API keys configured on server" });
  }

  try {
    const { messages, model, hasImage, imageBase64 } = req.body || {};
    const useVisionModel = Boolean(hasImage && imageBase64);

    const selectedModel = useVisionModel
      ? "meta-llama/llama-4-scout-17b-16e-instruct"
      : !model || model === "auto"
      ? "llama-3.3-70b-versatile"
      : model;

    const groqMessages = buildGroqMessages(messages, useVisionModel, imageBase64);
    const keysToTry = getOrderedKeys();

    let lastErrorData = { error: "All API keys failed" };
    let lastStatus = 502;

    for (const apiKey of keysToTry) {
      try {
        const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey.trim()}`
          },
          body: JSON.stringify({
            model: selectedModel,
            messages: groqMessages
          })
        });

        const data = await response.json().catch(() => ({}));

        if (response.ok) {
          return res.status(200).json(data);
        }

        lastStatus = response.status;
        lastErrorData = data;

        const shouldTryNextKey = response.status === 429 || response.status >= 500;
        if (!shouldTryNextKey) {
          break;
        }
      } catch (fetchErr) {
        lastStatus = 502;
        lastErrorData = { error: fetchErr?.message || "Upstream fetch failed" };
      }
    }

    return res.status(lastStatus).json(lastErrorData);
  } catch (err) {
    console.error("Zeno /api/chat error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
}
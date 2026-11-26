module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // حماية مرنة تعمل على جميع الهواتف وتطبيقات PWA
  const referer = req.headers.referer || '';
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  const isLocal =
    referer.includes('localhost') ||
    referer.includes('127.0.0.1') ||
    origin.includes('localhost');

  if (!isLocal && referer && host && !referer.includes(host) && origin && !origin.includes(host)) {
    return res.status(403).json({ error: 'Access Denied: Invalid Origin' });
  }

  const { messages, model: selectedModel, imageBase64 } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  // جلب مفاتيح GROQ_API_KEY أو GROQ_API_KEY_1, GROQ_API_KEY_2... بشكل دقيق
  const keys = Object.keys(process.env)
    .filter(key => key === 'GROQ_API_KEY' || /^GROQ_API_KEY_\d+$/.test(key))
    .map(key => (process.env[key] || '').trim())
    .filter(Boolean);

  if (keys.length === 0) {
    return res.status(500).json({
      error: 'لا توجد مفاتيح GROQ_API_KEY مضافة في إعدادات السيرفر'
    });
  }

  const shuffledKeys = [...keys].sort(() => Math.random() - 0.5);

  const visionModels = [
    'qwen/qwen3.8-27b'
  ];

  const defaultModels = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'qwen/qwen3.8-27b'
  ];

  let modelsToTry = imageBase64 ? [...visionModels] : [...defaultModels];

  if (selectedModel && selectedModel !== 'auto') {
    if (imageBase64) {
      modelsToTry = visionModels.includes(selectedModel)
        ? [selectedModel, ...visionModels.filter(m => m !== selectedModel)]
        : [...visionModels];
    } else {
      modelsToTry = [selectedModel, ...defaultModels.filter(m => m !== selectedModel)];
    }
  }

  const systemInstructions = `You are Zeno AI, an intelligent, creative technical AI assistant developed exclusively by NC Studio (استوديو NC).
Core rules:
1. Always respond in the exact same language as the user's latest message (Arabic, English, French, Spanish, Turkish, Kurdish, German, etc.), using a natural, friendly, conversational tone in that language.
2. When an image is attached, examine it accurately and answer the user's question about it.
3. For programming, always place code inside triple backticks (\`\`\`).
4. If asked who developed you, reply clearly in the user's language that you were developed by NC Studio ("من طورني هو استوديو NC" in Arabic, or "I was developed by NC Studio" in English).`;

  const MAX_MSG_CHARS = 4500;

  const recentMessages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant'))
    .slice(-6)
    .map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content.slice(0, MAX_MSG_CHARS)
        : String(m.content || '').slice(0, MAX_MSG_CHARS)
    }));

  if (imageBase64 && recentMessages.length > 0) {
    const lastIdx = recentMessages.length - 1;
    const lastMsg = recentMessages[lastIdx];
    const textContent = typeof lastMsg.content === 'string' && lastMsg.content.trim()
      ? lastMsg.content
      : 'Describe and analyze this image.';

    recentMessages[lastIdx] = {
      role: lastMsg.role,
      content: [
        { type: 'text', text: textContent },
        { type: 'image_url', image_url: { url: imageBase64 } }
      ]
    };
  }

  const fullMessages = [
    { role: 'system', content: systemInstructions },
    ...recentMessages
  ];

  async function callGroqWithTimeout(apiKey, modelName, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: modelName,
          messages: fullMessages,
          temperature: 0.6,
          max_tokens: 2048
        }),
        signal: controller.signal
      });

      const data = await response.json().catch(() => ({}));
      return { ok: response.ok, status: response.status, data };
    } finally {
      clearTimeout(timer);
    }
  }

  let lastGroqError = '';

  // نجرب النماذج على المفاتيح المتاحة بحد أقصى محاولتين لكل نموذج لتجنب بطء الاستضافة
  for (const modelName of modelsToTry) {
    for (const apiKey of shuffledKeys.slice(0, 2)) {
      try {
        const { ok, status, data } = await callGroqWithTimeout(apiKey, modelName, 15000);

        if (ok && data && Array.isArray(data.choices) && data.choices.length > 0) {
          return res.status(200).json(data);
        }

        lastGroqError = `${modelName} (${status}): ${data?.error?.message || 'Unknown error'}`;
      } catch (err) {
        lastGroqError = `${modelName}: ${err?.name === 'AbortError' ? 'Request timeout' : err.message}`;
      }
    }
  }

  return res.status(503).json({
    error: `فشل الاتصال: ${lastGroqError}`
  });
};
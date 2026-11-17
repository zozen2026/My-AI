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
  const isLocal = referer.includes('localhost') || referer.includes('127.0.0.1') || origin.includes('localhost');

  if (!isLocal && referer && !referer.includes(host) && origin && !origin.includes(host)) {
    return res.status(403).json({ error: 'Access Denied: Invalid Origin' });
  }

  const { messages, model: selectedModel } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  // جلب جميع مفاتيح GROQ_API_KEY المضافة في الاستضافة
  const keys = Object.keys(process.env)
    .filter(key => key.startsWith('GROQ_API_KEY'))
    .map(key => process.env[key]?.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    return res.status(500).json({ error: 'لا توجد مفاتيح GROQ_API_KEY مضافة في إعدادات السيرفر' });
  }

  const shuffledKeys = keys.sort(() => Math.random() - 0.5);

  // النماذج المستقرة والمؤكدة في Groq
  const defaultModels = [
    'llama-3.3-70b-versatile',
    'llama-3.1-8b-instant',
    'openai/gpt-oss-120b',
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'qwen/qwen3-32b'
  ];

  let modelsToTry = [...defaultModels];
  if (selectedModel && selectedModel !== 'auto') {
    modelsToTry = [selectedModel, ...defaultModels.filter(m => m !== selectedModel)];
  }

  const systemInstructions = `أنت Zeno AI، مساعد ذكي تقني ومبتكر مطور حصرياً من قِبل استوديو NC. 
قواعدك الأساسية:
1. تحدث دائماً باللهجة العامية الدارجة والمريحة المناسبة لأسلوب المستخدم.
2. في البرمجة: ضع الأكواد داخل علامات الكود الثلاثية (\`\`\`).
3. إذا سألك أحد عن مطورك أجب بكل وضوح: "من طورني هو استوديو NC".`;

  const recentMessages = messages.filter(m => m.role !== 'system').slice(-6);
  const fullMessages = [
    { role: "system", content: systemInstructions },
    ...recentMessages
  ];

  let lastGroqError = '';

  for (const apiKey of shuffledKeys) {
    for (const modelName of modelsToTry) {
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
            max_tokens: 900
          })
        });

        const data = await response.json();

        if (response.ok && data.choices && data.choices.length > 0) {
          return res.status(200).json(data);
        } else {
          lastGroqError = `${modelName}: ${data.error?.message || response.status}`;
        }
      } catch (err) {
        lastGroqError = err.message;
      }
    }
  }

  return res.status(503).json({
    error: `فشل الاتصال: ${lastGroqError}`
  });
};
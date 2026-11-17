module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const referer = req.headers.referer || '';
  const host = req.headers.host || '';
  const isLocal = referer.includes('localhost') || referer.includes('127.0.0.1');
  if (!isLocal && !referer.includes(host)) {
    return res.status(403).json({ error: 'Access Denied: Invalid Origin' });
  }

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid messages format' });
  }

  const keys = Object.keys(process.env)
    .filter(key => key.startsWith('GROQ_API_KEY'))
    .map(key => process.env[key]?.trim())
    .filter(Boolean);

  if (keys.length === 0) {
    return res.status(500).json({ error: 'لا توجد مفاتيح GROQ_API_KEY مضافة' });
  }

  const activeKey = keys[Math.floor(Math.random() * keys.length)];

  // فحص آخر رسالة من المستخدم لمعرفة هل يطلب صورة أم محادثة عادية
  const lastUserMessage = messages[messages.length - 1]?.content?.trim() || '';
  const imageTriggers = ['/رسم', '/image', 'ارسم لي', 'ارسم', 'صمم صورة', 'ولد صورة'];
  const isImageRequest = imageTriggers.some(trigger => lastUserMessage.startsWith(trigger));

  // ==========================================
  // 1. مسار توليد الصور (Pollinations.ai)
  // ==========================================
  if (isImageRequest) {
    // تنظيف النص من كلمة الأمر للحصول على الوصف الصافي
    let cleanPrompt = lastUserMessage;
    for (const trigger of imageTriggers) {
      if (cleanPrompt.startsWith(trigger)) {
        cleanPrompt = cleanPrompt.replace(trigger, '').trim();
        break;
      }
    }

    if (!cleanPrompt) {
      return res.status(200).json({
        choices: [{
          message: {
            role: 'assistant',
            content: 'اكتب وصف الصورة بعد الأمر، مثلاً: `/رسم رائد فضاء يشرب قهوة على القمر`'
          }
        }]
      });
    }

    try {
      // خطوة ذكية: استخدام Groq لترجمة الوصف للإنجليزية وتحسينه مجاناً قبل إرساله لـ Pollinations
      const translateRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${activeKey}`
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen3.8-27b',
          messages: [
            {
              role: 'system',
              content: 'Translate the user image prompt into a detailed, high-quality English prompt for an AI image generator. Output ONLY the English prompt, nothing else.'
            },
            { role: 'user', content: cleanPrompt }
          ],
          temperature: 0.5,
          max_tokens: 150
        })
      });

      const translateData = await translateRes.json();
      const englishPrompt = translateData.choices?.[0]?.message?.content?.trim() || cleanPrompt;
      const seed = Math.floor(Math.random() * 1000000);
      const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;

      // إرجاع الرد بصيغة Markdown للصورة + رابط تحميل مباشر
      return res.status(200).json({
        choices: [{
          message: {
            role: 'assistant',
            content: `تفضل، هذه صورتك:\n\n![${cleanPrompt}](${imageUrl})\n\n[⬇️ تحميل الصورة بجودة عالية](${imageUrl})`
          }
        }]
      });

    } catch (error) {
      return res.status(500).json({ error: 'حدث خطأ أثناء تجهيز الصورة' });
    }
  }

  // ==========================================
  // 2. مسار المحادثة النصية العادية (Groq)
  // ==========================================
  const systemInstructions = `أنت Zeno AI، مساعد ذكي تقني ومبتكر مطور حصرياً من قِبل استوديو NC. 
قواعدك الأساسية:
1. تحدث دائماً باللهجة العامية الدارجة والمريحة المناسبة لأسلوب المستخدم.
2. في البرمجة: ضع الأكواد داخل علامات الكود الثلاثية (\`\`\`).
3. إذا سألك أحد عن مطورك أجب بكل وضوح: "من طورني هو استوديو NC".`;

  const fullMessages = [
    { role: "system", content: systemInstructions },
    ...messages.filter(m => m.role !== 'system')
  ];

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${activeKey}`
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen3.8-27b',
        messages: fullMessages,
        temperature: 0.6,
        max_tokens: 1500
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data.error?.message || 'API Error'
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};
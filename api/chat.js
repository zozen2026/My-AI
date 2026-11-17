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

  // فحص آخر رسالة من المستخدم لمعرفة هل يطلب صورة أم محادثة عادية
  const lastUserMessage = messages[messages.length - 1]?.content?.trim() || '';
  const imageTriggers = ['/رسم', '/image', 'ارسم لي', 'ارسم', 'صمم صورة', 'ولد صورة'];
  const isImageRequest = imageTriggers.some(trigger => lastUserMessage.startsWith(trigger));

  // ==========================================
  // 1. مسار توليد الصور (Pollinations Image - مجاني 100%)
  // ==========================================
  if (isImageRequest) {
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

    const seed = Math.floor(Math.random() * 1000000);
    const imageUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(cleanPrompt)}?width=1024&height=1024&nologo=true&seed=${seed}`;

    return res.status(200).json({
      choices: [{
        message: {
          role: 'assistant',
          content: `تفضل، هذه صورتك:\n\n![${cleanPrompt}](${imageUrl})\n\n[⬇️ تحميل الصورة بجودة عالية](${imageUrl})`
        }
      }]
    });
  }

  // ==========================================
  // 2. مسار المحادثة النصية (Pollinations Text - مجاني بدون توكنز)
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
    const response = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai', // نموذج ذكي ومجاني بدون مفاتيح أو حدود توكنز
        messages: fullMessages,
        seed: Math.floor(Math.random() * 100000)
      })
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'تعذر الاتصال بالخادم حالياً، حاول مرة أخرى.'
      });
    }

    const data = await response.json();
    return res.status(200).json(data);

  } catch (error) {
    return res.status(500).json({ error: 'حدث خطأ في الاتصال بالخادم' });
  }
};
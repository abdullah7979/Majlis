'use strict';
// Decide which kind of task a message is. Two layers:
//   1. smart: ask a fast model (default Gemini Flash) to classify -> JSON
//   2. heuristic: weighted keyword scoring (Arabic + English), always available
// The smart result wins when it parses; otherwise the heuristic is used.

const { CATEGORIES } = require('./defaults');

const RULES = {
  prompt: [
    [/(برومبت|بروموت|برمبت|بروبمت|البرومبت|أمر (لـ|ل)|اوامر (لـ|ل)|أوامر (لـ|ل)|صياغة أمر)/, 6],
    [/\b(prompts?|system prompt|prompt engineer\w*|write a prompt|custom instructions?)\b/i, 6],
  ],
  image: [
    [/(صورة|صوره|(?:^|\s)صور(?:\s|$)|تصميم|صمم|شعار|لوقو|لوجو|بوستر|ارسم|رسمة|خلفية|أيقونة|ايقونة|بنر|ثمبنيل)/, 3],
    [/\b(image|logo|poster|draw|illustrat\w*|picture|thumbnail|banner|icon|wallpaper|mockup|render)\b/i, 3],
  ],
  code_heavy: [
    [/(مشروع كامل|تطبيق كامل|من الصفر|نظام كامل|أعد كتابة|اعد كتابة|هيكلة|ترحيل|معمارية)/, 4],
    [/\b(architecture|refactor\w*|from scratch|full[- ]stack|entire (app|project|codebase)|migrat\w*|monorepo|scaffold)\b/i, 4],
  ],
  code: [
    [/(كود|برمج|سكربت|سكريبت|دالة|خطأ برمجي|باق|ديبق|كومبايل|قاعدة بيانات|واجهة برمجية)/, 3],
    [/\b(code|bug|error|exception|stack ?trace|function|class|python|javascript|typescript|react|vue|flutter|dart|kotlin|swift|java|c#|c\+\+|rust|golang|sql|api|html|css|npm|git|github|compile|debug|regex|docker|deploy)\b/i, 3],
    [/```|=>|\bconst\b|\bdef\b|\bimport\b|;\s*$/m, 2],
  ],
  realtime: [
    [/(أخبار|اخبار|اليوم|الحين|ترند|تريند|عاجل|آخر|اخر المستجدات|سعر .{0,20} الآن|مباراة)/, 3],
    [/\b(news|today|trending|latest|right now|this week|breaking|live score|current price)\b/i, 3],
  ],
  research: [
    [/(ابحث|بحث|لخص|لخّص|تلخيص|حلل|حلّل|تحليل|قارن|مقارنة|ملف|تقرير|دراسة|مراجعة)/, 2],
    [/\b(research|summari[sz]e|analy[sz]e|compare|comparison|report|study|review|pdf|document|paper)\b/i, 2],
  ],
  writing: [
    [/(اكتب|مقال|مقالة|قصيدة|إيميل|ايميل|رسالة|تغريدة|منشور|محتوى|صياغة|صيغ|ترجم|ترجمة|سيرة ذاتية|خطاب)/, 2],
    [/\b(write|essay|email|article|blog|post|tweet|caption|translate|rewrite|proofread|cover letter|resume|story)\b/i, 2],
  ],
};

function heuristicClassify(text, { attachments = [] } = {}) {
  const scores = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  for (const [cat, rules] of Object.entries(RULES)) for (const [re, w] of rules) if (re.test(text)) scores[cat] += w;
  if (attachments.length) scores.research += 1;
  // A long coding request is usually a heavy one.
  if (scores.code > 0 && (text.length > 700 || scores.code_heavy > 0)) scores.code_heavy += scores.code;
  if (scores.code_heavy > 0) scores.code_heavy += 1;
  let best = 'quick', bestScore = 0;
  for (const c of CATEGORIES) if (scores[c] > bestScore) { best = c; bestScore = scores[c]; }
  if (best === 'quick' && text.length > 400) best = 'writing';
  // Confident = a clear signal (>=3) that beats the runner-up; otherwise a fast model breaks the tie.
  const sorted = Object.values(scores).sort((a, b) => b - a);
  const confident = bestScore >= 3 && sorted[0] - (sorted[1] || 0) >= 2;
  return { category: best, reason: bestScore ? 'keywords' : 'no strong signal', source: 'heuristic', confident };
}

function buildClassifierPrompt(text) {
  return [
    'You are a router. Classify the user request into exactly ONE category:',
    'code_heavy = large or multi-file programming work, building an app/system, architecture, refactors, hard bugs',
    'code = small or medium programming tasks, snippets, single bug fixes, explaining code',
    'prompt = writing or improving a prompt / instructions for an AI model or tool',
    'image = creating or designing images, logos, posters, UI visuals, illustrations',
    'research = analysis, summarizing documents or files, comparisons, deep explanations',
    'writing = writing or editing prose: articles, emails, posts, translation',
    'realtime = needs very recent information: news, trends, live prices, today\'s events',
    'quick = short simple question or chit-chat',
    '',
    'Reply with ONE line of JSON and nothing else: {"category":"<one of the above>","reason":"<max 8 words>"}',
    '',
    'User request:',
    '"""',
    text.slice(0, 4000),
    '"""',
  ].join('\n');
}

function parseClassifierOutput(out) {
  const matches = String(out || '').match(/\{[^{}]*"category"\s*:\s*"[a-z_]+"[^{}]*\}/g);
  if (!matches) return null;
  for (const m of matches.reverse()) {
    try {
      const j = JSON.parse(m);
      if (CATEGORIES.includes(j.category)) return { category: j.category, reason: String(j.reason || '').slice(0, 80), source: 'smart' };
    } catch (_) { /* try next */ }
  }
  return null;
}

module.exports = { heuristicClassify, buildClassifierPrompt, parseClassifierOutput };

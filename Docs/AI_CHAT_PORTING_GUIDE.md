# מדריך העתקה: צ'אט סוכנים רב־מודלי

## מה קיים בפרויקט

הרכיב הוא צ'אט **טקסטואלי** עם תשובות זורמות (streaming) ומודלים/ספקים מתחלפים. אין בו הקלטת מיקרופון, Speech-to-Text או Text-to-Speech. אם "צ'אט דיבור" התכוון לקול, יש להוסיף שכבת קול נפרדת לפני/אחרי הצ'אט המתואר כאן.

היישום מחבר בין:

```text
React ChatPanel
  -> POST /api/chat (fetch + AbortController)
  -> Express route (אימות קלט + SSE)
  -> adapter לפי ספק: Claude / Cursor / Codex
  -> CLI או SDK של הספק
  -> אירועי SSE חזרה לדפדפן
  -> עדכון הטקסט והסטטוס בזמן אמת
```

### החלטות תכנון חשובות

| נושא | המימוש | למה זה שימושי בפרויקט חדש |
| --- | --- | --- |
| Streaming | SSE על תשובת `POST` | עובד עם `fetch`, מאפשר לבטל בקשה ומציג טקסט מיידית. |
| ניתוק | `AbortController` בדפדפן ו־`req.close` בשרת | כפתור Stop מפסיק גם את תהליך המודל. |
| ספקים | חוזה אחיד של `AgentSelection` ו־`AgentEvent` | ה־UI אינו תלוי ב־CLI מסוים. |
| מצב | היסטוריית שיחה ב־Zustand; בחירת ספק ב־`localStorage` | פשוט לשילוב; בפרודקשן רצוי לשמור שיחות בשרת/DB. |
| בטיחות תהליך | Codex רץ בתיקיית temp וב־read-only | המודל אינו צריך גישת shell או כתיבה לפרויקט. |

## מפת הקבצים במקור

| אחריות | קובץ מקור |
| --- | --- |
| רכיב UI, בחירת מודל, שליחה/עצירה | `apps/web/src/chat/ChatPanel.tsx` |
| לקוח HTTP + פרסור SSE | `apps/web/src/chat/chatClient.ts` |
| renderer Markdown מינימלי | `apps/web/src/chat/markdownLite.tsx` |
| store להודעות ולמצב ריצה | `apps/web/src/store/packageStore.ts` |
| API, ולידציה והמרת אירועים ל־SSE | `apps/server/src/routes/chat.ts` |
| חוזי event והניתוב לספק | `apps/server/src/agent.ts` |
| קטלוג מודלים ונרמול בחירה | `apps/server/src/agent-catalog.ts` |
| סטטוס subscription והקטלוג החי | `apps/server/src/provider.ts`, `apps/server/src/codex-session.ts` |
| הרצת Codex CLI | `apps/server/src/agent-codex.ts` |

## חוזה API מומלץ

הבקשה מכילה את ההיסטוריה *ללא ההודעה האחרונה* או עם ההודעה האחרונה — בחרו כלל אחד ושמרו עליו. במקור, הלקוח מפריד את הודעת המשתמש האחרונה ל־`message`.

```ts
export type Provider = 'claude' | 'cursor' | 'codex';

export interface AgentSelection {
  provider: Provider;
  modelId: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  fast?: boolean;
}

export interface ChatRequest {
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  message: string;
  selection: AgentSelection;
}

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'turn_done' }
  | { type: 'error'; message: string };
```

אירועי ה־SSE בפועל הם שתי שורות ו־newline כפול:

```text
event: text_delta
data: {"type":"text_delta","text":"שלום"}

```

## קוד העתקה — שרת Express + SSE

זהו שלד עצמאי, ללא תלות ב־SSIS. החליפו את `runProvider` באדפטרים של הספקים הרצויים.

```ts
import { Router } from 'express';

export const chatRouter = Router();

chatRouter.post('/', async (req, res) => {
  const body = req.body as Partial<ChatRequest>;
  if (!body.message?.trim() || !Array.isArray(body.history) || !body.selection) {
    res.status(400).json({ error: 'Invalid chat request' });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // חשוב מאחורי nginx
  });
  res.flushHeaders();

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const emit = (event: AgentEvent) => {
    if (!res.writableEnded) {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  };

  try {
    await runProvider(body as ChatRequest, controller.signal, emit);
  } catch (error) {
    emit({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    if (!res.writableEnded) res.end();
  }
});
```

## קוד העתקה — לקוח SSE עם `fetch`

`EventSource` אינו מתאים כאן כי הוא מבצע GET בלבד. `fetch` נותן בקשת POST, headers, body ו־abort.

```ts
export async function streamChat(request: ChatRequest, signal: AbortSignal, onEvent: (e: AgentEvent) => void) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok || !response.body) throw new Error(await response.text());

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim();
      if (data) onEvent(JSON.parse(data) as AgentEvent);
    }
  }
}
```

דוגמת שימוש ב־React:

```tsx
const abortRef = useRef<AbortController | null>(null);
const [answer, setAnswer] = useState('');
const [sending, setSending] = useState(false);

async function send(message: string) {
  const controller = new AbortController();
  abortRef.current = controller;
  setSending(true); setAnswer('');
  try {
    await streamChat(requestFor(message), controller.signal, (event) => {
      if (event.type === 'text_delta') setAnswer((old) => old + event.text);
      if (event.type === 'error') showError(event.message);
    });
  } finally {
    setSending(false); abortRef.current = null;
  }
}

// <button onClick={() => abortRef.current?.abort()}>Stop</button>
```

## אדפטר ספק: Codex CLI

בפרויקט המקורי Codex מופעל כתהליך child, עם `codex exec --json`; כל שורת JSON מפוענחת ומומרת לחוזה האירועים. בגרסה המועתקת הוא פועל בתוך תיקיית temp ריקה, במצב read-only, וללא כלי מחשב, דפדפן או גישה לכתיבה. זהו עקרון בטיחות שכדאי לשמור.

```ts
const child = spawn(codexCommand, [
  '--disable', 'apps', '--disable', 'browser_use', '--disable', 'computer_use',
  '--disable', 'image_generation', '--disable', 'multi_agent',
  'exec', '--json', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--skip-git-repo-check',
  '-m', selection.modelId,
  prompt,
], { env: subscriptionOnlyEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

child.stdout.on('data', (chunk) => {
  for (const line of splitCompleteLines(chunk)) {
    const event = JSON.parse(line);
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      emit({ type: 'text_delta', text: event.item.text });
    }
    if (event.type === 'item.completed' && event.item?.type === 'reasoning') {
      emit({ type: 'thinking', text: event.item.text });
    }
    if (event.type === 'error') emit({ type: 'error', message: String(event.message) });
  }
});
signal.addEventListener('abort', () => child.kill(), { once: true });
```

במקור, `subscriptionOnlyEnv()` מוחק מ־environment משתנים כגון `OPENAI_API_KEY` ו־`OPENAI_BASE_URL`, כדי לאלץ שימוש ב־login המקומי של Codex/ChatGPT ולא לחשוף מפתחות. אין להניח שמבנה ה־JSON של CLI קבוע; יש להצמיד בדיקות גרסה ולוגיקת parsing לגרסת Codex הנתמכת אצלכם.

## UI והתנהגות שכדאי לשמור

- טענו `/api/chat/options` בפתיחה ורעננו סטטוס ספק כל 30 שניות.
- שמרו בחירה אחרונה ב־`localStorage`, אבל תמיד נרמלו אותה מול מודלים שהחשבון מחזיר כרגע.
- צרו הודעת assistant ריקה עם `pending: true` לפני תחילת הבקשה; כך יש מקום קבוע ל־deltas.
- הציגו `thinking` בנפרד מטקסט התשובה, אם הספק מחזיר אותו.
- צנזרו/הגבילו היסטוריה לפני שליחתה כדי לשלוט בעלות וב־context window.
- השתמשו במנוע Markdown בטוח. ה־renderer המקורי תומך רק בקוד וב־bold; אם עוברים ל־Markdown מלא, חייבים sanitize כדי למנוע XSS.

## אבטחה ופרודקשן

- האימות וההרשאה חייבים להיות בשרת לפני פתיחת stream.
- אין להעביר API keys לדפדפן או ל־prompt. השתמשו ב־secrets של השרת או בסשן CLI מקומי בלבד.
- הגבילו גודל `message`, מספר הודעות, זמן תור ו־concurrency לכל משתמש.
- ה־SSE route צריך heartbeat אם קיימים proxy/load balancer שמנתקים חיבורים שקטים.
- רשמו telemetry: ספק, מודל, משך, ביטול ושגיאות — בלי לשמור נתונים רגישים גולמיים.
- ב־Windows הפעילו CLI ישירות באמצעות `spawn(command, args)` ולא `shell: true`; במקור גם מזוהה entrypoint של npm כדי להימנע מבעיות quoting של `codex.cmd`.

## מה להעתיק בפועל

לגרסת MVP בפרויקט אחר מספיקים: `chatClient.ts`, route ה־SSE, חוזי האירועים, `ChatPanel` מצומצם ואדפטר אחד. הגרסה הזו היא צ'אט טקסט בלבד.

להוספת קול: הזרימה היא `Microphone -> STT -> send(text) -> streamChat -> TTS`. השאירו את ה־SSE ואת אדפטרי המודלים ללא שינוי; STT/TTS הם שכבת UI/מדיה מסביב לצ'אט.

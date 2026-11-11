const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type HistoryMessage = { role: "user" | "model"; text: string };
type QuizPayload = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  expiresAt: number;
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function requireText(value: unknown, name: string, maximum = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) {
    throw new Error(`Поле «${name}» должно содержать текст до ${maximum} символов.`);
  }
  return value.trim();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function quizEncryptionKey(apiKey: string): Promise<CryptoKey> {
  const keyMaterial = new TextEncoder().encode(`study-assistant-quiz-v1:${apiKey}`);
  const keyBytes = await crypto.subtle.digest("SHA-256", keyMaterial);
  return await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function createQuizToken(quiz: QuizPayload, apiKey: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await quizEncryptionKey(apiKey),
    new TextEncoder().encode(JSON.stringify(quiz)),
  );
  return `${encodeBase64Url(nonce)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
}

async function readQuizToken(token: unknown, apiKey: string): Promise<QuizPayload> {
  if (typeof token !== "string" || token.length > 8000) throw new Error("Срок теста истёк. Создай новый тест.");
  const [nonce, ciphertext, extra] = token.split(".");
  if (!nonce || !ciphertext || extra !== undefined) throw new Error("Не удалось проверить тест. Создай новый тест.");
  let quiz: QuizPayload;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decodeBase64Url(nonce) },
      await quizEncryptionKey(apiKey),
      decodeBase64Url(ciphertext),
    );
    quiz = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("Не удалось проверить тест. Создай новый тест.");
  }
  if (typeof quiz.question !== "string" || !Array.isArray(quiz.options) || quiz.options.length !== 4 ||
    !quiz.options.every((option) => typeof option === "string") ||
    !Number.isInteger(quiz.answerIndex) || quiz.answerIndex < 0 || quiz.answerIndex > 3 ||
    typeof quiz.explanation !== "string" || !Number.isInteger(quiz.expiresAt) || quiz.expiresAt <= Date.now()) {
    throw new Error("Срок теста истёк. Создай новый тест.");
  }
  return quiz;
}

async function askGemini(apiKey: string, systemInstruction: string, prompt: string, history: HistoryMessage[] = [], json = false) {
  const contents = [
    ...history.map(({ role, text }) => ({ role, parts: [{ text }] })),
    { role: "user", parts: [{ text: prompt }] },
  ];
  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents,
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1200,
          ...(json ? { responseMimeType: "application/json" } : {}),
        },
      }),
    },
  );
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const upstreamMessage = errorBody?.error?.message;
    const safeMessage = typeof upstreamMessage === "string"
      ? upstreamMessage
        .replaceAll(apiKey, "[REDACTED]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/[\r\n]/g, " ")
        .slice(0, 1000)
      : "No error message in Gemini response";
    console.error("Gemini request failed:", { status: response.status, message: safeMessage });
    throw new Error("Сервис ИИ временно недоступен. Проверь ключ Gemini и настройки функции в Supabase.");
  }
  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
  if (!text) throw new Error("ИИ не вернул ответ. Попробуй задать вопрос иначе.");
  return text;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse({ error: "Поддерживается только POST-запрос." }, 405);
  if (!request.headers.get("Authorization")?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Войди в аккаунт, чтобы пользоваться помощником." }, 401);
  }

  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) return jsonResponse({ error: "В Supabase не задан секрет GEMINI_API_KEY. Инструкция есть в README.md." }, 503);

  try {
    const body = await request.json();
    const problem = body.mode === "grade" ? "" : requireText(body.problem, "задача");
    let text: string;

    if (body.mode === "explain") {
      const history = Array.isArray(body.history)
        ? body.history.slice(-8).map((item: HistoryMessage) => {
          if (!item || !["user", "model"].includes(item.role) || typeof item.text !== "string" || item.text.length > 4000) {
            throw new Error("История диалога содержит некорректные данные.");
          }
          return { role: item.role, text: item.text };
        })
        : [];
      text = await askGemini(
        apiKey,
        "Ты доброжелательный русскоязычный ИИ-репетитор для школьников и студентов. Объясняй на русском простыми словами и по шагам: сначала определи тему и известные данные, затем покажи ход решения с причинами, проверь результат и предложи ученику попробовать похожий шаг самому. Не ограничивайся одним ответом. Если не хватает условия, задай уточняющий вопрос. Не выдумывай факты.",
        problem,
        history,
      );
      return jsonResponse({ text });
    }

    if (body.mode === "quiz") {
      text = await askGemini(
        apiKey,
        "Ты создаёшь короткий учебный тест на русском языке. Верни только JSON-объект с полями question (строка), options (ровно 4 строки), answerIndex (целое число от 0 до 3) и explanation (краткое объяснение верного ответа). Вопрос должен проверять понимание темы, а не запоминание случайных деталей.",
        `Составь один подходящий вопрос с четырьмя вариантами ответа по теме этой задачи. Не включай решение в вопрос. Тема/задача: ${problem}`,
        [],
        true,
      );
      const quiz = JSON.parse(text);
      if (typeof quiz.question !== "string" || quiz.question.length > 1000 ||
        !Array.isArray(quiz.options) || quiz.options.length !== 4 ||
        !quiz.options.every((option: unknown) => typeof option === "string" && option.length <= 500) ||
        !Number.isInteger(quiz.answerIndex) || quiz.answerIndex < 0 || quiz.answerIndex > 3 ||
        typeof quiz.explanation !== "string" || quiz.explanation.length > 2000) {
        throw new Error("ИИ подготовил тест в неверном формате. Попробуй ещё раз.");
      }
      const quizToken = await createQuizToken({
        question: quiz.question,
        options: quiz.options,
        answerIndex: quiz.answerIndex,
        explanation: quiz.explanation,
        expiresAt: Date.now() + 30 * 60 * 1000,
      }, apiKey);
      return jsonResponse({ question: quiz.question, options: quiz.options, quizToken });
    }

    if (body.mode === "grade") {
      if (!Number.isInteger(body.selectedIndex) || body.selectedIndex < 0 || body.selectedIndex > 3) {
        throw new Error("Вариант ответа передан в неверном формате.");
      }
      const quiz = await readQuizToken(body.quizToken, apiKey);
      const correct = body.selectedIndex === quiz.answerIndex;
      return jsonResponse({
        correct,
        feedback: correct ? "Правильно! Отличная работа." : "Этот вариант пока неверный. Ничего страшного — разберём решение.",
        explanation: quiz.explanation,
      });
    }

    return jsonResponse({ error: "Неизвестный режим помощника." }, 400);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось обработать запрос.";
    console.error("Study assistant request failed:", message);
    return jsonResponse({ error: message }, 400);
  }
});

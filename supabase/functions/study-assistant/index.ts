const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type HistoryMessage = { role: "user" | "model"; text: string };
type TutorImage = { mimeType: "image/jpeg" | "image/png" | "image/webp"; data: string };
type QuizPayload = {
  question: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  expiresAt: number;
};

class GeminiResponseError extends Error {
  constructor(message: string, readonly fallbackEligible = false) {
    super(message);
  }
}

class OpenAIResponseError extends Error {}

const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const GENERIC_AI_ERROR = "Сервис ИИ временно недоступен. Проверь ключ Gemini и настройки функции в Supabase.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAllowedImageType(value: string): value is TutorImage["mimeType"] {
  return value === "image/jpeg" || value === "image/png" || value === "image/webp";
}

function parseTutorImage(value: unknown): TutorImage | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value) || typeof value.mimeType !== "string" ||
    !isAllowedImageType(value.mimeType) || typeof value.data !== "string") {
    throw new Error("Изображение должно быть в формате JPG, PNG или WebP.");
  }
  if (!value.data || value.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    throw new Error("Не удалось прочитать изображение или его размер превышает 3 МБ.");
  }
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value.data), (character) => character.charCodeAt(0));
  } catch {
    throw new Error("Данные изображения имеют неверный формат.");
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error("Размер изображения не должен превышать 3 МБ.");
  }
  const isMatchingImage = value.mimeType === "image/jpeg"
    ? bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : value.mimeType === "image/png"
    ? bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    : bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 &&
      bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 &&
      bytes[11] === 0x50;
  if (!isMatchingImage) throw new Error("Формат файла не совпадает с типом изображения.");
  return { mimeType: value.mimeType, data: value.data };
}

function optionalText(value: unknown, name: string, maximum = 4000): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > maximum) {
    throw new Error(`Поле «${name}» должно содержать текст до ${maximum} символов.`);
  }
  return value.trim();
}

function sanitizeGeminiMessage(message: string, apiKey: string): string {
  return message
    .replaceAll(apiKey, "[скрыто]")
    .replace(/api[_ -]?key[ \t]*[:=][ \t]*[^, \t]+/gi, "API key=[скрыто]")
    .replace(/sk[-_][A-Za-z0-9_-]{16,}/g, "[скрыто]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[скрыто]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [скрыто]")
    .replace(/[\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function geminiErrorMessage(httpStatus: number, body: unknown, apiKey: string): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  const error = body.error;
  const status = typeof error.status === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(error.status)
    ? error.status
    : "";
  const code = typeof error.code === "number" && Number.isInteger(error.code) && error.code >= 100 &&
      error.code <= 599
    ? error.code
    : null;
  const rawMessage = typeof error.message === "string" ? error.message.slice(0, 2000) : "";
  if (!status && code === null && !rawMessage) return null;
  const message = rawMessage
    .replaceAll(apiKey, "[скрыто]")
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[скрыто]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [скрыто]")
    .replace(/[\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const sanitizedMessage = sanitizeGeminiMessage(message, apiKey);
  const diagnostic = sanitizedMessage || "Gemini не вернул описание ошибки.";
  const prefix = `Ошибка Gemini (${code === null ? `HTTP ${httpStatus}` : `код ${code}`}${status ? `, ${status}` : ""}): `;
  const keyAdvice = code === 401 || status === "UNAUTHENTICATED" || /api.?key.{0,30}(invalid|not valid)/i.test(sanitizedMessage)
    ? " Проверьте GEMINI_API_KEY в Supabase."
    : code === 403 || status === "PERMISSION_DENIED"
    ? " Проверьте доступ и ограничения ключа."
    : code === 429 || status === "RESOURCE_EXHAUSTED"
    ? " Проверьте квоту Gemini API."
    : "";
  const availableMessageLength = Math.max(0, 200 - prefix.length - keyAdvice.length);
  return `${prefix}${diagnostic.slice(0, availableMessageLength)}${keyAdvice}`.slice(0, 200);
}

function shouldFallbackToOpenAI(httpStatus: number, body: unknown): boolean {
  if (httpStatus === 503) return true;
  if (httpStatus !== 429 || !isRecord(body) || !isRecord(body.error)) return false;
  const error = body.error;
  const status = typeof error.status === "string" ? error.status : "";
  const message = typeof error.message === "string" ? error.message.slice(0, 2000) : "";
  return status === "RESOURCE_EXHAUSTED" || status === "RATE_LIMIT_EXCEEDED" ||
    /\b(?:rate[- ]?limit(?:ed|ing)?|quota(?:\s+(?:exceeded|limit|exhausted))?|capacity|overload(?:ed)?|resource[_ -]?exhausted|too many requests)\b/i
      .test(message);
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

async function askGemini(
  apiKey: string,
  systemInstruction: string,
  prompt: string,
  history: HistoryMessage[] = [],
  json = false,
  image?: TutorImage,
) {
  const contents = [
    ...history.map(({ role, text }) => ({ role, parts: [{ text }] })),
    {
      role: "user",
      parts: [
        ...(image ? [{ inlineData: { mimeType: image.mimeType, data: image.data } }] : []),
        { text: prompt },
      ],
    },
  ];
  let response: Response;
  try {
    response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
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
  } catch {
    throw new Error(GENERIC_AI_ERROR);
  }
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const fallbackEligible = shouldFallbackToOpenAI(response.status, errorBody);
    const upstreamMessage = errorBody?.error?.message;
    const safeMessage = typeof upstreamMessage === "string"
      ? upstreamMessage
        .replaceAll(apiKey, "[REDACTED]")
        .replace(/api[_ -]?key[ \t]*[:=][ \t]*[^, \t]+/gi, "API key=[REDACTED]")
        .replace(/sk[-_][A-Za-z0-9_-]{16,}/g, "[REDACTED]")
        .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED]")
        .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/[\r\n]/g, " ")
        .slice(0, 1000)
      : "No error message in Gemini response";
    console.error("Gemini request failed:", { status: response.status, message: safeMessage });
    const diagnostic = geminiErrorMessage(response.status, errorBody, apiKey);
    if (!diagnostic && !fallbackEligible) throw new Error(GENERIC_AI_ERROR);
    throw new GeminiResponseError(diagnostic ?? GENERIC_AI_ERROR, fallbackEligible);
  }
  const result = await response.json();
  const text = result?.candidates?.[0]?.content?.parts?.map((part: { text?: string }) => part.text || "").join("").trim();
  if (!text) throw new Error("ИИ не вернул ответ. Попробуй задать вопрос иначе.");
  return text;
}

async function askOpenAI(
  apiKey: string,
  systemInstruction: string,
  prompt: string,
  history: HistoryMessage[] = [],
  json = false,
  image?: TutorImage,
) {
  const input = [
    ...history.map(({ role, text }) => ({
      role: role === "model" ? "assistant" : "user",
      content: text,
    })),
    {
      role: "user",
      content: [
        ...(image
          ? [{
            type: "input_image",
            image_url: `data:${image.mimeType};base64,${image.data}`,
            detail: "auto",
          }]
          : []),
        { type: "input_text", text: prompt },
      ],
    },
  ];
  let response: Response;
  try {
    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: Deno.env.get("OPENAI_MODEL")?.trim() || "gpt-4.1-mini",
        instructions: systemInstruction,
        input,
        max_output_tokens: 1200,
        ...(json ? { text: { format: { type: "json_object" } } } : {}),
      }),
    });
  } catch {
    console.error("OpenAI request failed:", { status: "network", message: "No response from OpenAI API" });
    throw new OpenAIResponseError(GENERIC_AI_ERROR);
  }
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const errorMessage = isRecord(errorBody) && isRecord(errorBody.error) &&
        typeof errorBody.error.message === "string"
      ? sanitizeGeminiMessage(errorBody.error.message.slice(0, 2000), apiKey)
      : "No error message in OpenAI response";
    const errorType = isRecord(errorBody) && isRecord(errorBody.error) &&
        typeof errorBody.error.code === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(errorBody.error.code)
      ? errorBody.error.code
      : "unknown";
    console.error("OpenAI request failed:", {
      status: response.status,
      type: errorType,
      message: errorMessage.slice(0, 1000),
    });
    throw new OpenAIResponseError(GENERIC_AI_ERROR);
  }
  const result = await response.json();
  const outputText: string[] = [];
  if (isRecord(result) && Array.isArray(result.output)) {
    for (const item of result.output) {
      if (!isRecord(item) || item.type !== "message" || !Array.isArray(item.content)) continue;
      for (const block of item.content) {
        if (isRecord(block) && block.type === "output_text" && typeof block.text === "string") {
          outputText.push(block.text);
        }
      }
    }
  }
  const text = outputText.join("").trim();
  if (!text) throw new Error("ИИ не вернул ответ. Попробуй задать вопрос иначе.");
  return text;
}

async function askWithFallback(
  geminiApiKey: string,
  systemInstruction: string,
  prompt: string,
  history: HistoryMessage[] = [],
  json = false,
  image?: TutorImage,
) {
  try {
    return await askGemini(geminiApiKey, systemInstruction, prompt, history, json, image);
  } catch (error) {
    if (!(error instanceof GeminiResponseError) || !error.fallbackEligible) throw error;
    const openAIApiKey = Deno.env.get("OPENAI_API_KEY");
    if (!openAIApiKey) {
      console.error("OpenAI fallback unavailable: OPENAI_API_KEY is not configured");
      throw error;
    }
    try {
      return await askOpenAI(openAIApiKey, systemInstruction, prompt, history, json, image);
    } catch (fallbackError) {
      if (fallbackError instanceof OpenAIResponseError) throw error;
      throw fallbackError;
    }
  }
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
    if (body.mode !== "explain" && body.image !== undefined) {
      throw new Error("Изображение можно отправить только вместе с вопросом помощнику.");
    }
    const image = body.mode === "explain" ? parseTutorImage(body.image) : undefined;
    const problem = body.mode === "grade"
      ? ""
      : body.mode === "explain"
      ? optionalText(body.problem, "задача")
      : requireText(body.problem, "задача");
    let text: string;

    if (body.mode === "explain") {
      if (!problem && !image) throw new Error("Напиши вопрос или прикрепи изображение.");
      const history = Array.isArray(body.history)
        ? body.history.slice(-8).map((item: HistoryMessage) => {
          if (!item || !["user", "model"].includes(item.role) || typeof item.text !== "string" || item.text.length > 4000) {
            throw new Error("История диалога содержит некорректные данные.");
          }
          return { role: item.role, text: item.text };
        })
        : [];
      text = await askWithFallback(
        apiKey,
        "Ты доброжелательный русскоязычный репетитор. Пиши естественно и понятно для школьника: коротко представь, что нужно найти или понять, затем объясни решение по пронумерованным шагам и закончи ясным итогом. Используй короткие предложения, без канцелярита, лишнего жаргона и повторов. Объясняй, почему выполняется каждый важный шаг. Если используешь математический или предметный термин, сразу поясни его простыми словами. Подстраивай объяснение под предмет и возраст только если пользователь прямо указал их в задаче или истории. Сохраняй формулы и обозначения точными и поясняй смысл символов, если это нужно для понимания. Проверяй расчёты и опирайся на условие и достоверные сведения; не выдумывай факты и не угадывай недостающие данные. Если для решения не хватает условия, сначала задай конкретный уточняющий вопрос. Не добавляй лишнее задание в конце, если оно не помогает понять ответ. Верни только JSON-объект с полями answer и title. В answer помести полное объяснение в обычном Markdown. В title дай короткое название всего разговора на русском (3–7 слов, не длиннее 80 символов), учитывая историю и новый вопрос; не используй кавычки, вступление или точку в конце.",
        problem || "Внимательно прочитай изображение и объясни задачу на нём простыми словами и по шагам. Если условие неразборчиво, попроси прислать более чёткое фото.",
        history,
        true,
        image,
      );
      let tutorResponse: unknown;
      try {
        tutorResponse = JSON.parse(text);
      } catch {
        throw new Error("ИИ подготовил ответ в неверном формате. Попробуй ещё раз.");
      }
      if (!isRecord(tutorResponse) || typeof tutorResponse.answer !== "string" ||
        !tutorResponse.answer.trim() || tutorResponse.answer.length > 30000 ||
        typeof tutorResponse.title !== "string") {
        throw new Error("ИИ подготовил ответ или название в неверном формате. Попробуй ещё раз.");
      }
      const title = tutorResponse.title.replace(/\s+/g, " ").trim();
      if (!title || title.length > 120) {
        throw new Error("ИИ подготовил слишком длинное или пустое название. Попробуй ещё раз.");
      }
      return jsonResponse({ text: tutorResponse.answer.trim(), title });
    }

    if (body.mode === "quiz") {
      text = await askWithFallback(
        apiKey,
        "Ты составляешь короткие учебные тесты на простом естественном русском языке. Верни только JSON-объект с полями question (строка), options (ровно 4 строки), answerIndex (целое число от 0 до 3) и explanation (краткое и понятное объяснение верного ответа). Проверь понимание темы, а не запоминание случайных деталей. Подстраивай формулировки под предмет и возраст только если они указаны пользователем. Если используешь специальный термин, поясни его простыми словами. Используй только сведения из задачи и надёжные общеизвестные правила; не выдумывай факты и не добавляй неподтверждённые условия. Вопрос и варианты должны быть короткими, однозначными и соответствовать теме.",
        `Составь один подходящий вопрос с четырьмя вариантами ответа по теме этой задачи. Не включай решение в вопрос. В объяснении укажи, почему верный вариант подходит. Тема/задача: ${problem}`,
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
    const message = error instanceof GeminiResponseError
      ? error.message
      : error instanceof Error
      ? error.message
      : "Не удалось обработать запрос.";
    console.error("Study assistant request failed:", message);
    return jsonResponse({ error: message }, 400);
  }
});

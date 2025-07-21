
import { Application, Router } from "https://deno.land/x/oak@v12.6.1/mod.ts";

// Environment variables
const PROXY_AUTH_KEY = Deno.env.get("AUTHKEY") || "sk-yourkey";
const DEEPINFRA_API = "https://api.deepinfra.com/v1/openai";
const PORT = 8000;

// Random User-Agents for forwarding requests
const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15",
  "Mozilla/5.0 (Linux; Android 10; SM-G980F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
];

// Model list mapping (DeepInfra to OpenAI format)
const MODELS = [
  "Qwen/Qwen3-235B-A22B",
  "Qwen/Qwen3-14B",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-Turbo",
  "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
  "deepseek-ai/DeepSeek-V3-0324-Turbo",
  "deepseek-ai/DeepSeek-R1-0528-Turbo",
  "deepseek-ai/DeepSeek-R1-Distill-Llama-70B",
  "google/gemma-3-27b-it",
  "google/gemma-3-4b-it",
  "microsoft/phi-4-reasoning-plus",
  "microsoft/phi-4",
];

// Helper function to get random User-Agent
function getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Convert models to OpenAI format
function getOpenAIModels() {
  return {
    object: "list",
    data: MODELS.map((id) => ({
      id,
      object: "model",
      created: Math.floor(Date.now() / 1000),
      owned_by: "deepinfra",
    })),
  };
}

// Convert DeepInfra response to OpenAI format
function convertToOpenAIFormat(
  deepInfraResponse: any,
  isStream: boolean,
  model: string,
) {
  if (isStream) {
    // For streaming responses
    if (deepInfraResponse.choices && deepInfraResponse.choices[0].delta) {
      return {
        id: deepInfraResponse.id,
        object: "chat.completion.chunk",
        created: deepInfraResponse.created,
        model,
        choices: [{
          index: 0,
          delta: deepInfraResponse.choices[0].delta,
          finish_reason: deepInfraResponse.choices[0].finish_reason || null,
        }],
      };
    }
    return { data: "[DONE]" };
  } else {
    // For non-streaming responses
    return {
      id: deepInfraResponse.id,
      object: "chat.completion",
      created: deepInfraResponse.created,
      model,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: deepInfraResponse.choices?.[0]?.message?.content || "",
        },
        finish_reason: deepInfraResponse.choices?.[0]?.finish_reason || "stop",
      }],
      usage: deepInfraResponse.usage || {
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
      },
    };
  }
}

// Check authorization
function checkAuth(authHeader: string | null): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace("Bearer ", "").trim();
  return token === PROXY_AUTH_KEY;
}

// Proxy request to DeepInfra
async function proxyToDeepInfra(
  model: string,
  messages: any[],
  stream: boolean,
  max_tokens?: number,
  temperature?: number,
) {
  const url = `${DEEPINFRA_API}/chat/completions`;
  const payload = {
    model,
    messages,
    stream,
    max_tokens,
    temperature,
    stream_options: {
      include_usage: true,
      continuous_usage_stats: true,
    },
  };

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": getRandomUserAgent(),
    "X-Deepinfra-Source": "web-page",
    "Referer": "https://deepinfra.com/chat",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`DeepInfra API error: ${response.statusText}`);
  }

  return response;
}

// Setup server
const app = new Application();
const router = new Router();

// Middleware for authentication
app.use(async (ctx, next) => {
  if (ctx.request.url.pathname === "/v1/models") {
    // Allow model listing without auth
    await next();
  } else {
    const authHeader = ctx.request.headers.get("Authorization");
    if (!checkAuth(authHeader)) {
      ctx.response.status = 401;
      ctx.response.body = { error: "Unauthorized" };
      return;
    }
    await next();
  }
});

// GET /v1/models - Return model list in OpenAI format
router.get("/v1/models", (ctx) => {
  ctx.response.headers.set("Content-Type", "application/json");
  ctx.response.body = getOpenAIModels();
});

// POST /v1/chat/completions - Proxy to DeepInfra and convert response
router.post("/v1/chat/completions", async (ctx) => {
  try {
    const body = await ctx.request.body().value;
    const stream = body.stream === true;
    const model = body.model || "deepseek-ai/DeepSeek-V3-0324-Turbo";

    if (!MODELS.includes(model)) {
      ctx.response.status = 400;
      ctx.response.body = { error: "Invalid model specified" };
      return;
    }

    const deepInfraResponse = await proxyToDeepInfra(
      model,
      body.messages,
      stream,
      body.max_tokens,
      body.temperature,
    );

    if (stream) {
      // Handle streaming response
      ctx.response.headers.set("Content-Type", "text/event-stream");
      ctx.response.headers.set("Cache-Control", "no-cache");
      ctx.response.headers.set("Connection", "keep-alive");

      const reader = deepInfraResponse.body?.getReader();
      if (!reader) {
        throw new Error("No response body");
      }

      const readableStream = new ReadableStream({
        async start(controller) {
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n\n");

            // Process all complete lines (leave incomplete in buffer)
            for (let i = 0; i < lines.length - 1; i++) {
              const line = lines[i].trim();
              if (!line) continue;

              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") {
                  controller.enqueue("data: [DONE]\n\n");
                  continue;
                }

                try {
                  const jsonData = JSON.parse(data);
                  const openAIFormat = convertToOpenAIFormat(jsonData, true, model);
                  controller.enqueue(`data: ${JSON.stringify(openAIFormat)}\n\n`);
                } catch (e) {
                  console.error("Error parsing stream data:", e);
                }
              }
            }

            buffer = lines[lines.length - 1];
          }

          if (buffer.trim()) {
            try {
              const jsonData = JSON.parse(buffer);
              const openAIFormat = convertToOpenAIFormat(jsonData, true, model);
              controller.enqueue(`data: ${JSON.stringify(openAIFormat)}\n\n`);
            } catch (e) {
              console.error("Error parsing final buffer:", e);
            }
          }

          controller.enqueue("data: [DONE]\n\n");
          controller.close();
        },
      });

      ctx.response.body = readableStream;
    } else {
      // Handle non-streaming response
      const responseData = await deepInfraResponse.json();
      const openAIFormat = convertToOpenAIFormat(responseData, false, model);
      ctx.response.headers.set("Content-Type", "application/json");
      ctx.response.body = openAIFormat;
    }
  } catch (error) {
    console.error("Proxy error:", error);
    ctx.response.status = 500;
    ctx.response.body = { error: error.message };
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

console.log(`Server running on http://localhost:${PORT}`);
await app.listen({ port: PORT });

import crypto from "node:crypto";
import { logger } from "@langfuse/shared/src/server";
import Handlebars from "handlebars";

/**
 * Standard error handling for LLM operations
 * Handles common LLM errors like quota limits and throttling with appropriate status codes
 *
 * @param operation - The async LLM operation to execute
 * @param operationName - Name for error context (e.g., "call LLM")
 * @returns The result of the operation or throws an ApiError
 */
async function withLLMErrorHandling<T>(
  operation: () => Promise<T>,
  operationName: string = "LLM operation",
): Promise<T> {
  try {
    return await operation();
  } catch (e) {
    // Handle specific LLM provider errors with appropriate status codes
    if (
      e instanceof Error &&
      (e.name === "InsufficientQuotaError" || e.name === "ThrottlingException")
    ) {
      throw new ApiError(e.name, 429);
    }

    // Handle all other errors with preserved status codes
    throw new ApiError(
      `Failed to ${operationName}: ${e}`,
      (e as any)?.response?.status ?? (e as any)?.status,
    );
  }
}

export async function callStructuredLLM<T extends ZodV3Schema>(
  jeId: string,
  llmApiKey: z.infer<typeof LLMApiKeySchema>,
  messages: ChatMessage[],
  modelParams: z.infer<typeof ZodModelConfig>,
  provider: string,
  model: string,
  structuredOutputSchema: T,
  traceParams?: Omit<TraceParams, "tokenCountDelegate">,
): Promise<zodV3.infer<T>> {
  return withLLMErrorHandling(async () => {
    const { completion } = await fetchLLMCompletion({
      streaming: false,
      apiKey: decrypt(llmApiKey.secretKey), // decrypt the secret key
      extraHeaders: decryptAndParseExtraHeaders(llmApiKey.extraHeaders),
      baseURL: llmApiKey.baseURL || undefined,
      messages,
      modelParams: {
        provider,
        model,
        adapter: llmApiKey.adapter,
        ...modelParams,
      },
      traceParams: traceParams
        ? { ...traceParams, tokenCountDelegate: tokenCount }
        : undefined,
      structuredOutputSchema,
      config: llmApiKey.config,
      maxRetries: 1,
    });

    if (traceParams) {
      await processTracedEvents();
    }

    return structuredOutputSchema.parse(completion);
  }, "call LLM");
}

export async function callLLM(
  llmApiKey: z.infer<typeof LLMApiKeySchema>,
  messages: ChatMessage[],
  modelParams: z.infer<typeof ZodModelConfig>,
  provider: string,
  model: string,
  traceParams?: Omit<TraceParams, "tokenCountDelegate">,
): Promise<string> {
  return withLLMErrorHandling(async () => {
    const { completion, processTracedEvents } = await fetchLLMCompletion({
      streaming: false,
      apiKey: decrypt(llmApiKey.secretKey),
      extraHeaders: decryptAndParseExtraHeaders(llmApiKey.extraHeaders),
      baseURL: llmApiKey.baseURL || undefined,
      messages,
      modelParams: {
        provider,
        model,
        adapter: llmApiKey.adapter,
        ...modelParams,
      },
      config: llmApiKey.config,
      traceParams: traceParams
        ? { ...traceParams, tokenCountDelegate: tokenCount }
        : undefined,
      maxRetries: 1,
      throwOnError: false,
    });

    if (traceParams) {
      await processTracedEvents();
    }

    return completion;
  }, "call LLM");
}

export function compileHandlebarString(
  handlebarString: string,
  context: Record<string, any>,
): string {
  try {
    const template = Handlebars.compile(handlebarString, { noEscape: true });
    return template(context);
  } catch (error) {
    logger.info("Handlebars compilation error:", error);
    return handlebarString; // Fallback to the original string if Handlebars fails
  }
}

/**
 * Creates a W3C Trace Context compliant trace ID (16 bytes as 32 hex characters).
 *
 * @param {string} [seed] - Optional seed string for deterministic trace ID generation.
 *                          If provided, generates a trace ID by hashing the seed with SHA-256.
 *                          If omitted, generates a cryptographically random trace ID.
 * @returns {string} A 32-character hexadecimal string representing a 16-byte trace ID.
 *
 * @example
 * // Generate a random trace ID
 * const traceId = createW3CTraceId();
 * // => "a3f5b2c8d9e1f4a7b6c3d2e5f8a9b4c7"
 *
 * @example
 * // Generate a deterministic trace ID from a seed
 * const traceId = createW3CTraceId("my-seed-value");
 * // => "5d41402abc4b2a76b9719d911017c592"
 */
export function createW3CTraceId(seed?: string): string {
  if (seed) {
    const data = new TextEncoder().encode(seed);
    const hash = crypto.createHash("SHA-256").update(data).digest("hex");

    return hash.slice(0, 32); // take first 32 chars (16 bytes worth)
  } else {
    return crypto.randomBytes(16).toString("hex"); // already 32 chars
  }
}

import crypto from "node:crypto";
import {
  logger,
  fetchLLMCompletion,
  type TraceSinkParams,
  type ChatMessage,
} from "@langfuse/shared/src/server";
import { decrypt } from "@langfuse/shared/encryption";
import { ApiError } from "@langfuse/shared";
import { z } from "zod";
import { type ZodSchema } from "zod";

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

export async function callStructuredLLM<T extends ZodSchema>(
  jeId: string,
  llmApiKey: any,
  messages: ChatMessage[],
  modelParams: any,
  provider: string,
  model: string,
  structuredOutputSchema: T,
  traceSinkParams?: TraceSinkParams,
): Promise<z.infer<T>> {
  return withLLMErrorHandling(async () => {
    const completion = await fetchLLMCompletion({
      streaming: false,
      llmConnection: {
        secretKey: decrypt(llmApiKey.secretKey),
        extraHeaders: llmApiKey.extraHeaders,
        baseURL: llmApiKey.baseURL,
        config: llmApiKey.config as Record<string, string> | null,
      },
      messages,
      modelParams: {
        provider,
        model,
        adapter: llmApiKey.adapter,
        ...modelParams,
      },
      structuredOutputSchema,
      traceSinkParams,
      maxRetries: 1,
    });

    return completion as z.infer<T>;
  }, "call structured LLM");
}

export async function callLLM(
  llmApiKey: any,
  messages: ChatMessage[],
  modelParams: any,
  provider: string,
  model: string,
  traceSinkParams?: TraceSinkParams,
): Promise<string> {
  return withLLMErrorHandling(async () => {
    const completion = await fetchLLMCompletion({
      streaming: false,
      llmConnection: {
        secretKey: decrypt(llmApiKey.secretKey),
        extraHeaders: llmApiKey.extraHeaders,
        baseURL: llmApiKey.baseURL,
        config: llmApiKey.config as Record<string, string> | null,
      },
      messages,
      modelParams: {
        provider,
        model,
        adapter: llmApiKey.adapter,
        ...modelParams,
      },
      traceSinkParams,
      maxRetries: 1,
    });

    return completion;
  }, "call LLM");
}

export function compileTemplateString(
  template: string,
  context: Record<string, any>,
): string {
  try {
    return template.replace(/{{\s*([\w.]+)\s*}}/g, (match, key) => {
      if (key in context) {
        const value = context[key];
        return value === undefined || value === null ? "" : String(value);
      }
      return match; // missing key → return original variable including its braces
    });
  } catch (error) {
    logger.info("Template compilation error:", error);

    return template;
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Calculate the retention cutoff date for a given number of retention days.
 * Returns a Date representing the timestamp before which data should be deleted.
 */
export const getRetentionCutoffDate = (
  retentionDays: number,
  referenceDate: Date = new Date(),
): Date => {
  return new Date(referenceDate.getTime() - retentionDays * MS_PER_DAY);
};

// Alias for backward compatibility with code that uses the old Handlebars-based name
export const compileHandlebarString = compileTemplateString;

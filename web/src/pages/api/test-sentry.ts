import { captureException, captureMessage } from "@sentry/nextjs";
import { type NextApiRequest, type NextApiResponse } from "next";

/**
 * Test endpoint to verify Sentry integration
 *
 * Usage:
 * - GET /api/test-sentry?type=error (default) - sends a test error
 * - GET /api/test-sentry?type=message - sends a test message
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const testType = (req.query.type as string) || "error";

  try {
    if (testType === "message") {
      // Send a test message to Sentry
      captureMessage("Sentry integration test message", "info");

      return res.status(200).json({
        success: true,
        type: "message",
        message: "Test message sent to Sentry successfully!",
        instructions:
          "Check your Sentry dashboard for a message with level 'info' and text 'Sentry integration test message'",
      });
    } else {
      // Send a test error to Sentry
      const testError = new Error("Sentry integration test error");
      captureException(testError);

      return res.status(200).json({
        success: true,
        type: "error",
        message: "Test error sent to Sentry successfully!",
        instructions:
          "Check your Sentry dashboard for an error with message 'Sentry integration test error'",
      });
    }
  } catch (error) {
    captureException(error);

    return res.status(500).json({
      success: false,
      error: "Failed to send test to Sentry",
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

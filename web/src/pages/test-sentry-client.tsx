import { captureException, captureMessage } from "@sentry/nextjs";
import { Button } from "@/src/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/src/components/ui/card";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";

/**
 * Test page to verify client-side Sentry integration
 *
 * Access at: /test-sentry-client
 */
export default function TestSentryClient() {
  const [results, setResults] = useState<
    Array<{ type: string; message: string }>
  >([]);

  const handleTestError = () => {
    const testError = new Error("Client-side Sentry test error");
    captureException(testError);

    setResults([
      ...results,
      {
        type: "error",
        message:
          "Test error sent to Sentry! Check your Sentry dashboard for an error with message 'Client-side Sentry test error'",
      },
    ]);
  };

  const handleTestMessage = () => {
    captureMessage("Client-side Sentry test message", "info");

    setResults([
      ...results,
      {
        type: "message",
        message:
          "Test message sent to Sentry! Check your Sentry dashboard for a message with level 'info' and text 'Client-side Sentry test message'",
      },
    ]);
  };

  const handleTestUncaughtError = () => {
    setResults([
      ...results,
      {
        type: "uncaught",
        message:
          "About to throw an uncaught error. This should be automatically captured by Sentry!",
      },
    ]);

    // Throw an uncaught error after a short delay
    setTimeout(() => {
      throw new Error("Client-side uncaught test error");
    }, 100);
  };

  return (
    <div className="container mx-auto max-w-3xl py-8">
      <Card>
        <CardHeader>
          <CardTitle>Client-Side Sentry Integration Test</CardTitle>
          <CardDescription>
            Test if Sentry is properly capturing client-side errors and messages
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <h3 className="text-sm font-semibold">Test Actions</h3>
            <div className="flex flex-wrap gap-2">
              <Button onClick={handleTestError} variant="destructive">
                Send Test Error
              </Button>
              <Button onClick={handleTestMessage} variant="secondary">
                Send Test Message
              </Button>
              <Button onClick={handleTestUncaughtError} variant="outline">
                Throw Uncaught Error
              </Button>
            </div>
          </div>

          {results.length > 0 && (
            <div className="mt-6 space-y-3">
              <h3 className="text-sm font-semibold">Test Results</h3>
              {results.map((result, index) => (
                <div
                  key={index}
                  className="flex items-start gap-2 rounded-md border p-3"
                >
                  <CheckCircle2 className="mt-0.5 h-5 w-5 text-green-600" />
                  <div className="flex-1">
                    <p className="text-sm font-medium capitalize">
                      {result.type}
                    </p>
                    <p className="text-sm text-gray-600">{result.message}</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mt-6 rounded-md border bg-gray-50 p-4">
            <h3 className="mb-2 text-sm font-semibold">
              Verification Instructions
            </h3>
            <ol className="list-inside list-decimal space-y-1 text-sm text-gray-700">
              <li>Click one of the test buttons above</li>
              <li>Open your Sentry dashboard</li>
              <li>Navigate to the Issues page</li>
              <li>
                Look for the test error/message (it may take a few seconds to
                appear)
              </li>
              <li>
                Verify that the DSN in your .env matches your Sentry project
              </li>
            </ol>
          </div>

          <div className="mt-4 rounded-md border border-blue-200 bg-blue-50 p-4">
            <h3 className="mb-2 text-sm font-semibold text-blue-900">
              Current Configuration
            </h3>
            <div className="space-y-1 text-sm text-blue-800">
              <p>
                <span className="font-medium">DSN Configured:</span>{" "}
                {process.env.NEXT_PUBLIC_SENTRY_DSN ? "✓ Yes" : "✗ No"}
              </p>
              <p>
                <span className="font-medium">Environment:</span>{" "}
                {process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT || "Not set"}
              </p>
              <p>
                <span className="font-medium">Release:</span>{" "}
                {process.env.NEXT_PUBLIC_BUILD_ID || "Not set"}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

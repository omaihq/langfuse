import {
  type ConversationSheetMode,
  conversationSheetKeyExpression,
} from "@langfuse/shared";
import {
  buildConversationExportFilter,
  type ConversationExportScope,
  logger,
  parseClickhouseUTCDateTimeFormat,
  queryClickhouseStream,
} from "@langfuse/shared/src/server";
import { Readable } from "stream";
import { env } from "../../env";
import { resolveExportUserId } from "./getDatabaseReadStream";

export type ConversationExportRow = {
  /** Value rows are grouped into worksheets by. */
  sheetKey: string;
  userId: string | null;
  sessionId: string;
  timestamp: Date;
  input: string;
  output: string;
};

/**
 * Rows for a conversation workbook export.
 *
 * This is a separate query from the general trace export rather than an option
 * on it. It needs a different result shape (five columns, no scores join, no
 * comments lookup) and, crucially, a guaranteed ORDER BY — the trace export has
 * none, which is why exported conversations currently arrive with their turns
 * interleaved. Keeping it separate means the ordering requirement cannot change
 * the behaviour of the existing CSV/JSON/JSONL exports.
 *
 * Sorting by sheet key first lets the writer close each worksheet before the
 * next begins; sorting by timestamp last is what puts a conversation's turns in
 * the order they were actually said.
 */
export const getConversationExportStream = async (
  props: ConversationExportScope & {
    mode: ConversationSheetMode;
    rowLimit?: number;
  },
): Promise<Readable> => {
  const { projectId, mode, rowLimit = env.BATCH_EXPORT_ROW_LIMIT } = props;
  const { where, params } = buildConversationExportFilter(props);
  const sheetKey = conversationSheetKeyExpression(mode);

  const query = `
    SELECT
      ${sheetKey} AS sheet_key,
      t.id AS id,
      t.project_id AS project_id,
      t.user_id AS user_id,
      t.session_id AS session_id,
      t.timestamp AS timestamp,
      t.input AS input,
      t.output AS output
    FROM traces t
    WHERE ${where}
    ORDER BY sheet_key ASC, session_id ASC, timestamp ASC
    LIMIT 1 BY id, project_id
    LIMIT {rowLimit: Int64}
  `;

  const asyncGenerator = queryClickhouseStream<{
    sheet_key: string;
    id: string;
    project_id: string;
    user_id: string | null;
    session_id: string | null;
    timestamp: string;
    input: string | null;
    output: string | null;
  }>({
    query,
    params: { ...params, rowLimit },
    clickhouseConfigs: {
      request_timeout: 180_000,
      clickhouse_settings: {
        http_send_timeout: 300,
        http_receive_timeout: 300,
      },
    },
    tags: {
      feature: "batch-export",
      type: "trace",
      kind: "conversation-xlsx",
      projectId,
    },
  });

  let recordsProcessed = 0;

  return Readable.from(
    (async function* () {
      for await (const row of asyncGenerator) {
        recordsProcessed++;
        if (recordsProcessed % 10000 === 0) {
          logger.info(
            `Streaming conversation export for project ${projectId}: processed ${recordsProcessed} rows`,
          );
        }

        yield {
          // The raw user id may be an email or other PII; only ever emit the
          // salted pseudonym, including in the worksheet name.
          sheetKey:
            mode === "user"
              ? (resolveExportUserId(row.user_id) ?? "")
              : row.sheet_key,
          userId: resolveExportUserId(row.user_id),
          sessionId: row.session_id ?? "",
          timestamp: parseClickhouseUTCDateTimeFormat(row.timestamp),
          input: row.input ?? "",
          output: row.output ?? "",
        } satisfies ConversationExportRow;
      }
    })(),
  );
};

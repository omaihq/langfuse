import ExcelJS from "exceljs";
import { PassThrough, Readable } from "stream";
import {
  conversationXlsxColumns,
  toSheetCellText,
  toSheetName,
} from "@langfuse/shared";
import { logger } from "@langfuse/shared/src/server";
import { type ConversationExportRow } from "../database-read-stream/conversation-export-stream";

/** Excel refuses to open a worksheet with more rows than this. */
const XLSX_MAX_ROWS_PER_SHEET = 1_048_576;
const HEADER_ROWS = 1;

/** Bytes of finished archive allowed to queue up ahead of the upload. */
const OUTPUT_BUFFER_LIMIT_BYTES = 8 * 1024 * 1024;
const DRAIN_POLL_MS = 25;

const COLUMN_WIDTHS: Record<(typeof conversationXlsxColumns)[number], number> =
  {
    userId: 20,
    sessionId: 46,
    timestamp: 20,
    input: 80,
    output: 80,
  };

/**
 * Writes grouped conversation rows into a streamed xlsx workbook.
 *
 * Returns immediately with the readable side of the archive so the caller can
 * hand it straight to the S3 multipart upload; rows are written as they arrive.
 * Every row and every worksheet is committed as soon as it is complete, so
 * memory stays flat regardless of export size — this relies on the input being
 * sorted by `sheetKey`, which `getConversationExportStream` guarantees.
 *
 * Values are written as native cell types rather than serialised text. That is
 * the whole point of the format: the CSV export JSON-encodes every field, so
 * spreadsheet users see `"quoted"` strings, and its lack of a byte-order mark
 * makes Excel decode UTF-8 as CP1252 and mangle every curly quote and dash.
 * Neither problem can occur here.
 */
export const writeConversationXlsx = (props: {
  rows: Readable;
  maxSheets: number;
  onError: (error: Error) => void;
}): Readable => {
  const { rows, maxSheets, onError } = props;

  const output = new PassThrough();
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useStyles: true,
    // Inline strings. Conversation text barely repeats, so a shared-string
    // table would buy nothing and would have to be held in memory in full.
    useSharedStrings: false,
  });

  const usedSheetNames = new Set<string>();
  let currentSheet: ExcelJS.Worksheet | undefined;
  let currentKey: string | undefined;
  let sheetCount = 0;
  let sheetRowCount = 0;
  let totalRows = 0;

  const startSheet = (key: string) => {
    sheetCount++;
    if (sheetCount > maxSheets) {
      throw new Error(
        `Export would produce more than ${maxSheets} worksheets. Narrow the date range or filters and try again.`,
      );
    }

    const sheet = workbook.addWorksheet(
      toSheetName(key, usedSheetNames, "(no value)"),
    );
    sheet.columns = conversationXlsxColumns.map((name) => ({
      header: name,
      key: name,
      width: COLUMN_WIDTHS[name],
    }));
    // `columns` writes the header into the in-memory row; commit it so the
    // streaming writer flushes it before any data rows follow.
    sheet.getRow(HEADER_ROWS).commit();
    sheet.getColumn("timestamp").numFmt = "yyyy-mm-dd hh:mm:ss";

    currentSheet = sheet;
    currentKey = key;
    sheetRowCount = 0;
  };

  /**
   * Holds the read loop while the upload falls behind.
   *
   * Committing a row hands it to the zip writer, which buffers into `output`
   * without pushing back on us, so a slow upload would otherwise let the whole
   * workbook accumulate in memory — exactly what streaming is meant to avoid.
   * Waiting on the buffered byte count bounds that at the threshold below.
   */
  const waitForConsumer = async () => {
    while (
      output.readableLength > OUTPUT_BUFFER_LIMIT_BYTES &&
      !output.destroyed
    ) {
      await new Promise((resolve) => setTimeout(resolve, DRAIN_POLL_MS));
    }
  };

  const run = async () => {
    for await (const row of rows as AsyncIterable<ConversationExportRow>) {
      if (currentKey !== row.sheetKey || !currentSheet) {
        currentSheet?.commit();
        startSheet(row.sheetKey);
      }

      if (sheetRowCount >= XLSX_MAX_ROWS_PER_SHEET - HEADER_ROWS) {
        // A single group larger than a worksheet has to spill. Continuing into
        // a suffixed sheet keeps the data rather than silently dropping the
        // tail, which is what writing past the limit would do.
        currentSheet?.commit();
        startSheet(row.sheetKey);
      }

      currentSheet
        ?.addRow({
          userId: row.userId ?? "",
          sessionId: toSheetCellText(row.sessionId),
          timestamp: row.timestamp,
          input: toSheetCellText(row.input),
          output: toSheetCellText(row.output),
        })
        .commit();

      sheetRowCount++;
      totalRows++;

      await waitForConsumer();
    }

    if (currentSheet) {
      currentSheet.commit();
    } else {
      // A workbook with no worksheets is not a valid xlsx file.
      const empty = workbook.addWorksheet("no results");
      empty.columns = conversationXlsxColumns.map((name) => ({
        header: name,
        key: name,
        width: COLUMN_WIDTHS[name],
      }));
      empty.getRow(HEADER_ROWS).commit();
      empty.commit();
    }

    await workbook.commit();
    logger.info(
      `Conversation xlsx export written: ${totalRows} rows across ${sheetCount} worksheets`,
    );
  };

  run().catch((error) => {
    const err = error instanceof Error ? error : new Error(String(error));
    // Destroying the output aborts the in-flight upload rather than leaving a
    // truncated but readable workbook in the bucket.
    output.destroy(err);
    onError(err);
  });

  return output;
};

/**
 * Conversation workbook exports (fork-local).
 *
 * Researchers analysing GBA conversations do not want the raw trace table:
 * they want one spreadsheet per study, split into tabs, holding just the
 * de-identified participant, the time, and what was said. Producing that from
 * the CSV export is hours of manual work per run, so it is a first-class
 * export format instead.
 *
 * Everything specific to that shape lives in this file so the diff against
 * upstream Langfuse stays small and obvious on the next sync.
 */

import { BatchExportFileFormat } from "./types";

/** How rows are split across worksheets. */
export type ConversationSheetMode = "topic" | "user";

export const conversationXlsxFormats: Partial<
  Record<BatchExportFileFormat, ConversationSheetMode>
> = {
  [BatchExportFileFormat.XLSX_BY_TOPIC]: "topic",
  [BatchExportFileFormat.XLSX_BY_USER]: "user",
};

export const conversationSheetMode = (
  format: string,
): ConversationSheetMode | undefined =>
  conversationXlsxFormats[format as BatchExportFileFormat];

export const isConversationXlsxFormat = (format: string): boolean =>
  conversationSheetMode(format) !== undefined;

/**
 * Excel slows to a crawl and its tab strip becomes unusable well before a
 * thousand sheets, so an export that would exceed this is rejected up front
 * rather than delivering a workbook nobody can open. Splitting by user is the
 * mode that realistically hits it — the caller is expected to narrow the date
 * range or filter to a cohort.
 */
export const CONVERSATION_XLSX_MAX_SHEETS = 500;

/** Excel's hard limit on characters in a single cell. */
export const XLSX_MAX_CELL_LENGTH = 32767;

export const conversationXlsxColumns = [
  "userId",
  "sessionId",
  "timestamp",
  "input",
  "output",
] as const;

/**
 * ClickHouse expression yielding the value rows are grouped and sorted by.
 *
 * Grouping is done in SQL rather than in the writer so that rows arrive
 * already contiguous per sheet: the writer can then finalise each worksheet
 * before opening the next and never holds more than one sheet in memory.
 * It also means the pre-flight sheet count and the actual export derive the
 * key the same way, so the count cannot disagree with what gets written.
 *
 * `user` mode groups on the raw `user_id`. The exported value is a salted
 * pseudonym, but that mapping is deterministic and injective, so grouping on
 * the raw id produces exactly the same partition.
 */
export const conversationSheetKeyExpression = (
  mode: ConversationSheetMode,
): string => {
  if (mode === "user") return "ifNull(t.user_id, '')";

  // Session ids are `[<prefix>-]TA:<Topic>_<DDMon>_<uuid>`; the topic is
  // everything before the date segment. Sessions that do not follow the
  // convention fall back to the whole id rather than collapsing into one tab.
  const sessionId = "ifNull(t.session_id, '')";
  const topicPattern = "'^(.*?)_[0-9]{2}[A-Za-z]{3}_'";
  const extracted = `extract(${sessionId}, ${topicPattern})`;

  return `replaceRegexpOne(if(${extracted} != '', ${extracted}, ${sessionId}), '^TA:', '')`;
};

const SHEET_NAME_MAX_LENGTH = 31;
/** Characters Excel rejects in a worksheet name. */
const SHEET_NAME_ILLEGAL = /[[\]:*?/\\]/g;
/** Reserved by Excel for the change-history sheet. */
const SHEET_NAME_RESERVED = "history";

/**
 * Trims leading and trailing apostrophes, which Excel rejects at either end of
 * a sheet name.
 *
 * Done by scanning rather than with `/^'+|'+$/`: the key comes from ingested
 * session and user ids, so a caller could send a long run of apostrophes and
 * make that pattern backtrack. Two linear scans cannot.
 */
const trimApostrophes = (value: string): string => {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === "'") start++;
  while (end > start && value[end - 1] === "'") end--;

  return value.slice(start, end);
};

/**
 * Turns a group key into a name Excel will accept, unique within the workbook.
 *
 * Truncation makes collisions possible between keys that were distinct (two
 * long topics sharing a prefix), so uniqueness is resolved against the names
 * already used rather than assumed.
 */
export const toSheetName = (
  rawKey: string,
  usedNames: Set<string>,
  fallback = "unnamed",
): string => {
  const cleaned = trimApostrophes(
    rawKey.replace(SHEET_NAME_ILLEGAL, " ").replace(/\s+/g, " "),
  ).trim();

  let base = cleaned.slice(0, SHEET_NAME_MAX_LENGTH).trim();
  if (!base || base.toLowerCase() === SHEET_NAME_RESERVED) base = fallback;

  let candidate = base;
  let suffixIndex = 2;
  while (usedNames.has(candidate.toLowerCase())) {
    const suffix = `~${suffixIndex}`;
    candidate = `${base.slice(0, SHEET_NAME_MAX_LENGTH - suffix.length)}${suffix}`;
    suffixIndex++;
  }

  usedNames.add(candidate.toLowerCase());
  return candidate;
};

/**
 * Strips characters that are legal in ClickHouse but not in the XML Excel
 * reads. A single stray control character makes the whole workbook
 * unopenable, and truncation past Excel's cell limit does the same, so both
 * are handled here rather than trusted to the writer.
 */
export const toSheetCellText = (value: unknown): string => {
  if (value === null || value === undefined) return "";

  const asText = typeof value === "string" ? value : JSON.stringify(value);
  // eslint-disable-next-line no-control-regex
  const printable = asText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");

  return printable.length > XLSX_MAX_CELL_LENGTH
    ? `${printable.slice(0, XLSX_MAX_CELL_LENGTH - 1)}…`
    : printable;
};

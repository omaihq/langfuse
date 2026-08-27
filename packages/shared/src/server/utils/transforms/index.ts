import { Transform } from "stream";

import { BatchExportFileFormat } from "../../../features/batchExport/types";
import { transformStreamToCsv } from "./transformStreamToCsv";
import { transformStreamToJson } from "./transformStreamToJson";
import { transformStreamToJsonl } from "./transformStreamToJsonl";

/**
 * Formats produced by streaming rows through a text transform.
 *
 * The XLSX conversation formats are excluded deliberately: a workbook is a zip
 * archive built from grouped input, not a row-at-a-time text stream, so it has
 * its own writer. Keeping them out of this map means a caller that forgets to
 * branch fails to compile instead of emitting a `.xlsx` full of JSON lines.
 */
export type StreamableExportFileFormat = Exclude<
  BatchExportFileFormat,
  BatchExportFileFormat.XLSX_BY_TOPIC | BatchExportFileFormat.XLSX_BY_USER
>;

export const streamTransformations: Record<
  StreamableExportFileFormat,
  () => Transform
> = {
  CSV: transformStreamToCsv,
  JSON: transformStreamToJson,
  JSONL: transformStreamToJsonl,
};

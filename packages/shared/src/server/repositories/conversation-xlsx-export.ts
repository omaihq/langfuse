import {
  type ConversationSheetMode,
  conversationSheetKeyExpression,
  conversationSheetKeyPresent,
} from "../../features/batchExport/conversationXlsx";
import { type FilterCondition } from "../../types";
import { type TracingSearchType } from "../../interfaces/search";
import { tracesTableUiColumnDefinitions } from "../tableMappings/mapTracesTable";
import { createFilterFromFilterState } from "../queries/clickhouse-sql/factory";
import { FilterList } from "../queries/clickhouse-sql/clickhouse-filter";
import { clickhouseSearchCondition } from "../queries/clickhouse-sql/search";
import { queryClickhouse } from "./clickhouse";

export type ConversationExportScope = {
  projectId: string;
  cutoffCreatedAt: Date;
  filter: FilterCondition[] | null;
  searchQuery?: string | undefined;
  searchType?: TracingSearchType[] | undefined;
};

/**
 * Builds the WHERE clause shared by the sheet count and the export itself.
 *
 * Both must see exactly the same rows: a count taken over a different
 * predicate than the export would either wave through a workbook that
 * overflows the sheet cap or reject one that would have been fine.
 */
export const buildConversationExportFilter = (
  scope: ConversationExportScope,
) => {
  const { projectId, cutoffCreatedAt, filter, searchQuery, searchType } = scope;

  // Observation-level filters cannot be applied without joining observations,
  // which this query deliberately avoids. Upstream's trace export drops them
  // the same way.
  const traceOnlyFilters = (filter ?? []).filter((f) => {
    const columnDef = tracesTableUiColumnDefinitions.find(
      (col) => col.uiTableName === f.column || col.uiTableId === f.column,
    );
    return columnDef?.clickhouseTableName !== "observations";
  });

  const filterList = new FilterList([]);
  filterList.push(
    ...createFilterFromFilterState(
      [
        ...traceOnlyFilters,
        {
          column: "timestamp",
          operator: "<" as const,
          value: cutoffCreatedAt,
          type: "datetime" as const,
        },
      ],
      tracesTableUiColumnDefinitions,
    ),
  );

  const applied = filterList.apply();
  const search = clickhouseSearchCondition(searchQuery, searchType, "t");

  return {
    where: `t.project_id = {projectId: String}
      ${applied.query ? `AND ${applied.query}` : ""}
      ${search.query}`,
    params: {
      projectId,
      ...applied.params,
      ...search.params,
    },
  };
};

/**
 * Number of worksheets the export would produce.
 *
 * Checked before any work starts so an oversized request fails as an error the
 * user sees immediately, rather than as a workbook delivered by email an hour
 * later that Excel cannot usefully open.
 */
export const countConversationExportSheets = async (
  props: ConversationExportScope & { mode: ConversationSheetMode },
): Promise<number> => {
  const { mode, projectId } = props;
  const { where, params } = buildConversationExportFilter(props);

  const rows = await queryClickhouse<{ sheet_count: string }>({
    query: `
      SELECT uniqExact(${conversationSheetKeyExpression(mode)}) AS sheet_count
      FROM traces t
      WHERE ${where}
        AND ${conversationSheetKeyPresent(mode)}
    `,
    params,
    tags: {
      feature: "batch-export",
      type: "trace",
      kind: "count",
      projectId,
    },
  });

  return Number(rows[0]?.sheet_count ?? 0);
};

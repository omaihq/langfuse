import type { OrderByState } from "@langfuse/shared";
import {
  orderByToClickhouseSql,
  queryClickhouse,
} from "@langfuse/shared/src/server";
import { sessionCols } from "../../../../../packages/shared/src/server/tableMappings/mapSessionTable";

export type SimplifiedSessionData = {
  session_id: string;
  user_ids: string[];
  min_timestamp: string;
};

export const getFilteredSessions = async (props: {
  projectId: string;
  allowedUserIds: string[];
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const { projectId, allowedUserIds, orderBy, limit, page } = props;

  if (allowedUserIds.length === 0) {
    return [];
  }

  const query = `
    WITH deduplicated_traces AS (
      SELECT * EXCEPT input, output, metadata
      FROM traces t
      WHERE t.session_id IS NOT NULL 
        AND t.project_id = {projectId: String}
        AND t.user_id IN {allowedUserIds: Array(String)}
        AND t.user_id IS NOT NULL
        AND t.user_id != ''
        ORDER BY event_ts DESC
        LIMIT 1 BY id, project_id
    ),
    session_data AS (
        SELECT
            t.session_id,
            min(t.timestamp) as min_timestamp,
            groupUniqArray(t.user_id) AS user_ids
        FROM deduplicated_traces t
        WHERE t.session_id IS NOT NULL
            AND t.project_id = {projectId: String}
            AND t.user_id IN {allowedUserIds: Array(String)}
            AND t.user_id IS NOT NULL
            AND t.user_id != ''
        GROUP BY t.session_id
    )
    SELECT 
        session_id,
        user_ids,
        min_timestamp
    FROM session_data s
    WHERE length(user_ids) > 0
    AND hasAny(user_ids, {allowedUserIds: Array(String)})
    ${orderByToClickhouseSql(orderBy ?? null, sessionCols)}
    ${limit !== undefined && page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
    `;

  const res = await queryClickhouse<SimplifiedSessionData>({
    query: query,
    params: {
      projectId,
      allowedUserIds,
      limit: limit,
      offset: limit && page ? limit * page : 0,
    },
    tags: {
      feature: "conversations",
      type: "filtered-sessions",
      projectId,
    },
  });

  return res;
};

/**
 * Optimized version for fetching all sessions without pre-fetching user list.
 * Optionally filters by a single accountId if provided.
 * Scales efficiently even with 100k+ users.
 */
export const getAllSessionsWithOptionalUserFilter = async (props: {
  projectId: string;
  accountId?: string;
  orderBy?: OrderByState;
  limit?: number;
  page?: number;
}) => {
  const { projectId, accountId, orderBy, limit, page } = props;

  // Build the user filter condition dynamically
  const userFilterCondition = accountId
    ? "AND t.user_id = {accountId: String}"
    : "";

  const query = `
    WITH deduplicated_traces AS (
      SELECT * EXCEPT input, output, metadata
      FROM traces t
      WHERE t.session_id IS NOT NULL 
        AND t.project_id = {projectId: String}
        AND t.user_id IS NOT NULL
        AND t.user_id != ''
        ${userFilterCondition}
        ORDER BY event_ts DESC
        LIMIT 1 BY id, project_id
    ),
    session_data AS (
        SELECT
            t.session_id,
            min(t.timestamp) as min_timestamp,
            groupUniqArray(t.user_id) AS user_ids
        FROM deduplicated_traces t
        WHERE t.session_id IS NOT NULL
            AND t.project_id = {projectId: String}
            AND t.user_id IS NOT NULL
            AND t.user_id != ''
            ${userFilterCondition}
        GROUP BY t.session_id
    )
    SELECT 
        session_id,
        user_ids,
        min_timestamp
    FROM session_data s
    WHERE length(user_ids) > 0
    ${orderByToClickhouseSql(orderBy ?? null, sessionCols)}
    ${limit !== undefined && page !== undefined ? `LIMIT {limit: Int32} OFFSET {offset: Int32}` : ""}
    `;

  const params: Record<string, unknown> = {
    projectId,
    limit: limit,
    offset: limit && page ? limit * page : 0,
  };

  // Only add accountId to params if it's provided
  if (accountId) {
    params.accountId = accountId;
  }

  const res = await queryClickhouse<SimplifiedSessionData>({
    query: query,
    params: params,
    tags: {
      feature: "conversations",
      type: "all-sessions-optional-filter",
      projectId,
    },
  });

  return res;
};

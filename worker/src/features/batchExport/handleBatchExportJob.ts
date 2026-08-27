import { pipeline, Transform } from "stream";
import {
  BatchExportFileFormat,
  BatchExportQuerySchema,
  BatchExportStatus,
  BatchExportTableName,
  conversationSheetMode,
  CONVERSATION_XLSX_MAX_SHEETS,
  exportOptions,
  InvalidRequestError,
  LangfuseNotFoundError,
} from "@langfuse/shared";
import { prisma } from "@langfuse/shared/src/db";
import {
  StorageServiceFactory,
  sendBatchExportSuccessEmail,
  streamTransformations,
  type BatchExportJobType,
  logger,
  getCurrentSpan,
  applyCommentFilters,
  type CommentObjectType,
  countConversationExportSheets,
  type StreamableExportFileFormat,
} from "@langfuse/shared/src/server";
import { env } from "../../env";
import {
  getDatabaseReadStreamPaginated,
  isExportUserIdDisabled,
} from "../database-read-stream/getDatabaseReadStream";
import { getObservationStream } from "../database-read-stream/observation-stream";
import { getTraceStream } from "../database-read-stream/trace-stream";
import { getConversationExportStream } from "../database-read-stream/conversation-export-stream";
import { writeConversationXlsx } from "./writeConversationXlsx";

// Map table names to comment object types for preprocessing
const tableToCommentType: Record<string, CommentObjectType | undefined> = {
  traces: "TRACE",
  observations: "OBSERVATION",
  sessions: "SESSION",
};

export const handleBatchExportJob = async (
  batchExportJob: BatchExportJobType,
) => {
  if (env.LANGFUSE_S3_BATCH_EXPORT_ENABLED !== "true") {
    throw new Error(
      "Batch export is not enabled. Configure environment variables to use this feature. See https://langfuse.com/self-hosting/infrastructure/blobstorage#batch-exports for more details.",
    );
  }

  const { projectId, batchExportId } = batchExportJob;

  logger.info(`Starting batch export for ${projectId} and ${batchExportId}`);

  if (isExportUserIdDisabled()) {
    logger.warn(
      `LANGFUSE_EXPORT_USER_ID_SALT is not set - batch export ${batchExportId} will emit an empty userId for every row`,
    );
  }

  const span = getCurrentSpan();
  if (span) {
    span.setAttribute(
      "messaging.bullmq.job.input.batchExportId",
      batchExportId,
    );
    span.setAttribute("messaging.bullmq.job.input.projectId", projectId);
  }

  // Get job details from DB
  const jobDetails = await prisma.batchExport.findFirst({
    where: {
      projectId,
      id: batchExportId,
    },
  });

  if (!jobDetails) {
    throw new LangfuseNotFoundError(
      `Job not found for project: ${projectId} and export ${batchExportId}`,
    );
  }

  // Check if the batch export has been cancelled
  if (jobDetails.status === BatchExportStatus.CANCELLED) {
    logger.info(
      `Batch export ${batchExportId} has been cancelled. Skipping processing.`,
    );
    return; // Exit early without processing
  }

  // Check if the batch export is older than 30 days
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  if (jobDetails.createdAt < thirtyDaysAgo) {
    // For old exports, mark as failed with an informative message
    const improvedExportMessage =
      "We have improved the batch export feature. Please retry your export to benefit from the latest enhancements.";

    await prisma.batchExport.update({
      where: {
        id: batchExportId,
        projectId,
      },
      data: {
        status: BatchExportStatus.FAILED,
        finishedAt: new Date(),
        log: improvedExportMessage,
      },
    });

    logger.info(
      `Batch export ${batchExportId} is older than 30 days. Marked as failed with retry message.`,
    );

    return; // Exit early without processing
  }

  if (jobDetails.status !== BatchExportStatus.QUEUED) {
    logger.warn(
      `Job ${batchExportId} has invalid status: ${jobDetails.status}. Retrying anyway.`,
    );
  }

  // Set job status to processing
  await prisma.batchExport.update({
    where: {
      id: batchExportId,
      projectId,
    },
    data: {
      status: BatchExportStatus.PROCESSING,
    },
  });

  // Parse query from job
  const parsedQuery = BatchExportQuerySchema.safeParse(jobDetails.query);
  if (!parsedQuery.success) {
    throw new Error(
      `Failed to parse query for ${batchExportId}: ${parsedQuery.error.message}`,
    );
  }

  if (span) {
    span.setAttribute(
      "messaging.bullmq.job.input.query",
      JSON.stringify(parsedQuery.data),
    );
  }

  // Process comment filters before creating stream
  const commentObjectType = tableToCommentType[parsedQuery.data.tableName];
  let processedFilter = parsedQuery.data.filter ?? [];

  if (commentObjectType) {
    const { filterState, hasNoMatches } = await applyCommentFilters({
      filterState: parsedQuery.data.filter ?? [],
      prisma,
      projectId,
      objectType: commentObjectType,
    });

    if (hasNoMatches) {
      // No matching items - complete export with empty results
      logger.info(
        `Batch export ${batchExportId}: comment filter matched no items, completing with empty export`,
      );

      // Create an empty stream by using a filter that matches nothing
      processedFilter = [
        {
          type: "stringOptions" as const,
          operator: "any of" as const,
          column: "id",
          value: [],
        },
      ];
    } else {
      processedFilter = filterState;
    }
  }

  // Conversation workbooks are a distinct pipeline: a different query shape, a
  // required sort order, and a zip writer instead of a text transform. Anything
  // that is not one of those formats takes the untouched path below.
  const sheetMode = conversationSheetMode(jobDetails.format);

  if (sheetMode) {
    if (parsedQuery.data.tableName !== BatchExportTableName.Traces) {
      throw new InvalidRequestError(
        `Conversation workbook exports are only available for traces, not ${parsedQuery.data.tableName}.`,
      );
    }

    if (sheetMode === "user" && isExportUserIdDisabled()) {
      throw new InvalidRequestError(
        "Splitting by user requires LANGFUSE_EXPORT_USER_ID_SALT to be configured, otherwise every row would export without a user id.",
      );
    }

    // Checked before the upload starts so an oversized request fails cleanly
    // instead of producing a workbook Excel cannot usefully open.
    const sheetCount = await countConversationExportSheets({
      projectId,
      cutoffCreatedAt: jobDetails.createdAt,
      filter: processedFilter,
      searchQuery: parsedQuery.data.searchQuery,
      searchType: parsedQuery.data.searchType,
      mode: sheetMode,
    });

    if (sheetCount > CONVERSATION_XLSX_MAX_SHEETS) {
      throw new InvalidRequestError(
        `This export would produce ${sheetCount} worksheets, above the limit of ${CONVERSATION_XLSX_MAX_SHEETS}. Narrow the date range or filters and try again.`,
      );
    }
  }

  // handle db read stream

  const dbReadStream = sheetMode
    ? await getConversationExportStream({
        projectId,
        cutoffCreatedAt: jobDetails.createdAt,
        filter: processedFilter,
        searchQuery: parsedQuery.data.searchQuery,
        searchType: parsedQuery.data.searchType,
        mode: sheetMode,
      })
    : parsedQuery.data.tableName === BatchExportTableName.Observations
      ? await getObservationStream({
          projectId,
          cutoffCreatedAt: jobDetails.createdAt,
          ...parsedQuery.data,
          filter: processedFilter,
        })
      : parsedQuery.data.tableName === BatchExportTableName.Traces
        ? await getTraceStream({
            projectId,
            cutoffCreatedAt: jobDetails.createdAt,
            ...parsedQuery.data,
            filter: processedFilter,
          })
        : await getDatabaseReadStreamPaginated({
            projectId,
            cutoffCreatedAt: jobDetails.createdAt,
            ...parsedQuery.data,
            filter: processedFilter,
          });

  // Transform data to desired format
  let rowCount = 0;

  const loggingTransform = new Transform({
    objectMode: true,
    transform(chunk, encoding, callback) {
      rowCount++;
      if (rowCount % 5000 === 0) {
        logger.info(
          `Batch export ${batchExportId}: processed ${rowCount} rows`,
        );
      }
      callback(null, chunk);
    },
  });

  const onPipelineFinished = (err: NodeJS.ErrnoException | null) => {
    if (err) {
      logger.error("Getting data from DB and transform failed: ", err);
    } else {
      logger.info(
        `Batch export ${batchExportId}: completed processing ${rowCount} total rows`,
      );
    }
  };

  const fileStream = sheetMode
    ? writeConversationXlsx({
        rows: pipeline(dbReadStream, loggingTransform, onPipelineFinished),
        maxSheets: CONVERSATION_XLSX_MAX_SHEETS,
        onError: (err) =>
          logger.error(
            `Batch export ${batchExportId}: writing workbook failed`,
            err,
          ),
      })
    : pipeline(
        dbReadStream,
        loggingTransform,
        streamTransformations[
          jobDetails.format as StreamableExportFileFormat
        ](),
        onPipelineFinished,
      );

  const fileDate = new Date().getTime();
  const fileExtension =
    exportOptions[jobDetails.format as BatchExportFileFormat].extension;
  const fileName = `${env.LANGFUSE_S3_BATCH_EXPORT_PREFIX}${fileDate}-lf-${parsedQuery.data.tableName}-export-${projectId}.${fileExtension}`;
  const expiresInSeconds =
    env.BATCH_EXPORT_DOWNLOAD_LINK_EXPIRATION_HOURS * 3600;

  // Stream upload results to S3
  const bucketName = env.LANGFUSE_S3_BATCH_EXPORT_BUCKET;
  if (!bucketName) {
    throw new Error("No S3 bucket configured for exports.");
  }

  const { signedUrl } = await StorageServiceFactory.getInstance({
    bucketName,
    accessKeyId: env.LANGFUSE_S3_BATCH_EXPORT_ACCESS_KEY_ID,
    secretAccessKey: env.LANGFUSE_S3_BATCH_EXPORT_SECRET_ACCESS_KEY,
    endpoint: env.LANGFUSE_S3_BATCH_EXPORT_ENDPOINT,
    externalEndpoint: env.LANGFUSE_S3_BATCH_EXPORT_EXTERNAL_ENDPOINT,
    region: env.LANGFUSE_S3_BATCH_EXPORT_REGION,
    forcePathStyle: env.LANGFUSE_S3_BATCH_EXPORT_FORCE_PATH_STYLE === "true",
    awsSse: env.LANGFUSE_S3_BATCH_EXPORT_SSE,
    awsSseKmsKeyId: env.LANGFUSE_S3_BATCH_EXPORT_SSE_KMS_KEY_ID,
  }).uploadWithSignedUrl({
    fileName,
    fileType:
      exportOptions[jobDetails.format as BatchExportFileFormat].fileType,
    data: fileStream,
    expiresInSeconds,
    partSize: env.BATCH_EXPORT_S3_PART_SIZE_MIB * 1024 * 1024,
    queueSize: 4,
  });

  logger.info(`Batch export file ${fileName} uploaded to S3`);

  // Update job status
  await prisma.batchExport.update({
    where: {
      id: batchExportId,
      projectId,
    },
    data: {
      status: BatchExportStatus.COMPLETED,
      url: signedUrl,
      finishedAt: new Date(),
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
    },
  });

  // Send email to user
  const user = await prisma.user.findFirst({
    where: {
      id: jobDetails.userId,
    },
  });

  if (user?.email) {
    await sendBatchExportSuccessEmail({
      env,
      receiverEmail: user.email,
      downloadLink: signedUrl,
      userName: user?.name || "",
      batchExportName: jobDetails.name,
    });

    logger.info(
      `Batch export with id ${batchExportId} for project ${projectId} successful. Email sent to user ${user.id}`,
    );
  }
};

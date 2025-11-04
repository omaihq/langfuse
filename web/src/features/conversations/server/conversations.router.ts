import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { orderBy, paginationZod } from "@langfuse/shared";
import { logger } from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import z from "zod/v4";
import { getAllSessionsWithOptionalUserFilter } from "./conversations-service";

const SessionFilterOptions = z.object({
  projectId: z.string(), // Required for protectedProjectProcedure
  orderBy: orderBy,
  accountId: z.string().optional(), // Optional accountId filter
  ...paginationZod,
});

export const conversationsRouter = createTRPCRouter({
  all: protectedProjectProcedure
    .input(SessionFilterOptions)
    .query(async ({ input }) => {
      try {
        const sessions = await getAllSessionsWithOptionalUserFilter({
          projectId: input.projectId,
          orderBy: input.orderBy,
          page: input.page,
          limit: input.limit,
        });

        return {
          sessions: sessions.map((s) => ({
            id: s.session_id,
            userIds: s.user_ids,
            createdAt: new Date(s.min_timestamp),
          })),
        };
      } catch (e) {
        logger.error("Unable to call sessions.all", e);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "unable to get sessions",
        });
      }
    }),
});

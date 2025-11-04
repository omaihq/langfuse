import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import { createSupabaseAdminClient } from "@/src/server/supabase";
import { orderBy, paginationZod } from "@langfuse/shared";
import { getSessionsTable, logger } from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import z from "zod/v4";
import { getFilteredSessions } from "./conversations-service";

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
        let sessions;

        const supabase = createSupabaseAdminClient();

        // Fetch users from User table
        const usersFromUserTable = await supabase
          .schema("public")
          .from("User")
          .select("identifier");

        if (usersFromUserTable.error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "unable to get users from User table",
          });
        }

        // Fetch users from test_users table
        const usersFromTestUsersTable = await supabase
          .schema("public")
          .from("test_users")
          .select("username");

        if (usersFromTestUsersTable.error) {
          throw new TRPCError({
            code: "INTERNAL_SERVER_ERROR",
            message: "unable to get users from test_users table",
          });
        }

        // Combine both sources and remove duplicates
        const usernamesFromUserTable = usersFromUserTable.data
          .map((user) => user.identifier)
          .filter((identifier): identifier is string => identifier !== null);

        const usernamesFromTestUsersTable = usersFromTestUsersTable.data.map(
          (user) => user.username,
        );

        // Create a Set to remove duplicates, then convert back to array
        const usernames = Array.from(
          new Set([...usernamesFromUserTable, ...usernamesFromTestUsersTable]),
        );

        // Filter for specific accountId if provided, within allowed users
        const filteredUsernames = input.accountId
          ? usernames.filter((username) => username === input.accountId)
          : usernames;

        sessions = await getFilteredSessions({
          projectId: input.projectId,
          allowedUserIds: filteredUsernames,
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

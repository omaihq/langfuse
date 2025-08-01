import { api } from "@/src/utils/api";
import Link from "next/link";

interface RecentConversationsProps {
  projectId: string;
  userId: string | null;
  currentSessionId: string;
}

export function RecentConversations({
  projectId,
  userId,
  currentSessionId,
}: RecentConversationsProps) {
  // Don't fetch if userId is null
  const recentConversations =
    api.conversation.getRecentConversationsForUser.useQuery(
      {
        projectId,
        userId: userId || "",
        limit: 10,
      },
      {
        enabled: !!userId, // Only run the query if userId is not null
      },
    );

  // Don't show anything if userId is null
  if (!userId) {
    return null;
  }

  if (recentConversations.isError) {
    return (
      <div className="text-sm text-red-600">
        Failed to load recent conversations
      </div>
    );
  }

  const conversations = recentConversations.data?.sessions || [];

  // // Filter out the current session and get the most recent ones
  // const otherConversations = conversations.filter(
  //   (conv) => conv.id !== currentSessionId,
  // );

  const otherConversations = conversations;

  if (otherConversations.length === 0) {
    return null; // Don't show anything if no other conversations
  }

  const formatTimeAgo = (date: Date) => {
    const now = new Date();
    const diffInMs = now.getTime() - date.getTime();
    const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
    const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
    const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

    if (diffInMinutes < 1) return "Just now";
    if (diffInMinutes < 60) return `${diffInMinutes}m ago`;
    if (diffInHours < 24) return `${diffInHours}h ago`;
    if (diffInDays < 7) return `${diffInDays}d ago`;
    return date.toLocaleDateString();
  };

  return (
    <div className="mb-4">
      <div className="mb-2 text-xs text-muted-foreground">
        Recent conversations for{" "}
        <Link
          href={`/project/${projectId}/conversations?accountId=${userId}`}
          className="text-blue-600 hover:text-blue-800 hover:underline"
        >
          {userId}
        </Link>
      </div>
      <div className="space-y-1">
        {otherConversations.map((conversation) => {
          const isCurrentSession = conversation.id === currentSessionId;

          return (
            <div key={conversation.id}>
              <Link
                href={`/project/${projectId}/conversations/${conversation.id}`}
                className={`inline-block rounded-full px-2 py-1 text-xs ${
                  isCurrentSession
                    ? "border border-blue-300 bg-blue-100 text-blue-800"
                    : "bg-secondary text-blue-600 text-secondary-foreground hover:text-blue-800"
                }`}
              >
                {conversation.id} • {formatTimeAgo(conversation.createdAt)}
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}

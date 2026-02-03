# OmAI HQ Custom Features Documentation

This document outlines the custom features and modifications added to Langfuse by the **OmAI HQ team** (David Halapir and Adrian Punkt). These features extend the base Langfuse functionality to support specialized conversation analytics, user management, and research capabilities.

## Table of Contents

- [Overview](#overview)
- [Custom Navigation & Routing](#custom-navigation--routing)
- [Accounts Management System](#accounts-management-system)
- [Advanced Conversations Feature](#advanced-conversations-feature)
- [Scoring System](#scoring-system)
- [Backend Integrations](#backend-integrations)
- [Database Schema Extensions](#database-schema-extensions)
- [Usage Guide](#usage-guide)
- [Technical Implementation](#technical-implementation)

## Overview

The OmAI HQ customizations focus on:
- **Multi-type user management** (Real, Synthetic, Snapshot users)
- **Advanced conversation analytics** with custom scoring
- **Conversation replay and generation capabilities**
- **Research-oriented data collection and analysis**

### Key Contributors
- **David Halapir** (`halapir.david@gmail.com`) - Backend systems, scoring, user management
- **Adrian Punkt** (`me@adrianpunkt.com`) - Frontend integration, routing, conversation features

## Custom Navigation & Routing

### OMAI-Specific Navigation Routes

**File:** [`web/src/components/layouts/routes.tsx`](web/src/components/layouts/routes.tsx)

```typescript
export const OMAI_ROUTES: Route[] = [
  {
    title: "Go to...",
    pathname: "",
    icon: Search,
    menuNode: <CommandMenuTrigger />,
    section: RouteSection.Main,
  },
  {
    title: "Accounts",
    pathname: `/project/[projectId]/accounts`,
    icon: UserIcon,
    group: RouteGroup.OMAI,
    section: RouteSection.Main,
  },
  {
    title: "Conversations",
    pathname: `/project/[projectId]/conversations`,
    icon: MessageSquare,
    group: RouteGroup.OMAI,
    section: RouteSection.Main,
  },
  // ... other routes
];
```

### Features:
- Dedicated OMAI route group in sidebar navigation
- Admin-only visibility controls
- Custom command menu integration

## Accounts Management System

### Three-Tier User System

**Main Component:** [`web/src/features/accounts/AccountsPage.tsx`](web/src/features/accounts/AccountsPage.tsx)

The system provides three distinct user types:

#### 1. Real Users
- Standard users from Supabase authentication
- Full access to all features
- No special metadata flags

#### 2. Synthetic Users
**Component:** [`web/src/features/accounts/synthetic/SyntheticUsersPage.tsx`](web/src/features/accounts/synthetic/SyntheticUsersPage.tsx)

```typescript
// Auto-generated username pattern
const generateSyntheticUsername = ({name}: {name: string}) => {
  return `synth_${name}_${Date.now()}`;
};

// DJB metadata structure
djb_metadata: {
  synthetic: {
    prompt_name: promptName,
    notes: input.notes,
  },
}
```

**Features:**
- Auto-generated usernames with `synth_` prefix
- Hardcoded passwords for testing environments
- Associated prompt templates for conversation generation
- Custom metadata tracking

#### 3. Snapshot Users
**Component:** [`web/src/features/accounts/snapshot/SnapshotUsersPage.tsx`](web/src/features/accounts/snapshot/SnapshotUsersPage.tsx)

```typescript
// Snapshot users are read-only
<p>
  Snapshot users are automatically created from message views and
  cannot be manually created or edited. They are read-only and
  contain metadata from the original conversation context.
</p>
```

**Features:**
- Auto-created from conversation contexts
- Read-only (cannot be manually created/edited)
- Contains conversation metadata snapshots

### Backend Router

**File:** [`web/src/features/accounts/server/accounts.router.ts`](web/src/features/accounts/server/accounts.router.ts)

Key endpoints:
- `getUsers` - Fetches real users (filters out synthetic/snapshot)
- `getSyntheticUsers` - Fetches users with `synthetic` metadata
- `getSnapshotUsers` - Fetches users with `snapshot` metadata
- `createSyntheticUser` - Creates synthetic users with prompts

## Advanced Conversations Feature

### Conversation View System

**Main Component:** [`web/src/features/conversations/conversation-view/ConversationView.tsx`](web/src/features/conversations/conversation-view/ConversationView.tsx)

#### Recent Conversations Integration
**Component:** [`web/src/features/conversations/conversation-view/RecentConversations.tsx`](web/src/features/conversations/conversation-view/RecentConversations.tsx)

```typescript
export function RecentConversations({
  projectId,
  userId,
  currentSessionId,
}: RecentConversationsProps) {
  const recentConversations = api.conversation.getRecentConversationsForUser.useQuery({
    projectId,
    userId: userId || "",
    limit: 10,
  });
  
  // Shows conversation history for specific users
  // Links to individual conversation sessions
}
```

#### Conversation Replay Functionality
**Component:** [`web/src/features/conversations/table-definition.tsx`](web/src/features/conversations/table-definition.tsx)

```typescript
const handleConfirmReplay = () => {
  const threadId = extractUuidFromSessionId(row.original.id);
  
  replayConversation.mutate({
    threadId: threadId,
    userIdentifier: replayUsername.trim(),
    projectId: projectId,
  });
};
```

**Features:**
- Replay conversations with different usernames
- UUID extraction from session IDs
- Integration with backend replay API

## Scoring System

### Custom Score Configuration

**File:** [`web/src/features/conversations/conversation-view/score-config.ts`](web/src/features/conversations/conversation-view/score-config.ts)

```typescript
export type OmaiScoreConfig = {
  id: string;
  label: string;
  options: readonly string[];
};

export const OMAI_SCORE_CONFIGS: Array<OmaiScoreConfig> = [
  {
    id: "overall-rating",
    label: "Overall Rating",
    options: ["Good", "Just Ok", "Not good"],
  },
  {
    id: "error-coding",
    label: "Error Coding",
    options: [
      "Discussion", "Sycophancy", "Vague", "Leading",
      "Unnecessary Restating", "Wrong Information", "Gears Wrong",
      "Safety Flag", "Multiple Questions", "Overinterpretation",
      "Giving Advice", "Inquiry Needed"
    ],
  },
  {
    id: "gears",
    label: "Gears",
    options: ["First Gear", "Second Gear", "Third Gear"],
  },
  {
    id: "conversation-indicator",
    label: "Good Conversation Indicator",
    options: [
      "Competence", "Checking Comprehension", "Value Alignment",
      "Empathy/Rapport", "Transparency", "Reliability/Consistency",
      "Autonomy Support", "Experiential Exploration", "Explaining the Method"
    ],
  },
];
```

### Score Color Coding

**File:** [`web/src/features/conversations/conversation-view/score-colors.ts`](web/src/features/conversations/conversation-view/score-colors.ts)

```typescript
export const SCORE_COLORS: Record<string, string> = {
  "Good": "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  "Not good": "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  "Just Ok": "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  // ... more color mappings
};
```

### Message Scoring Component

The scoring system integrates directly into the conversation view with:
- Multi-select scoring interface
- Real-time score updates
- User-specific score tracking
- Score deletion with confirmation dialogs

## Conversation Summary Page

**File:** [`web/src/features/conversations/conversation-summary/ConversationSummaryPage.tsx`](web/src/features/conversations/conversation-summary/ConversationSummaryPage.tsx)

**Route:** `/project/[projectId]/conversations/summary/[conversationId]`

A comprehensive analytics dashboard for individual conversations that provides:

### Features
- **TTFT (Time To First Token) Metrics**: Visual histogram and statistics for response times
- **Session Scores**: Detailed score cards with category grouping
- **Compact Scores Grid**: Turn-by-turn score visualization with color coding
- **Conversation Turns Table**: Full conversation with inline scores

### Score Explanations

The page includes built-in explanations for common metrics:

```typescript
const SCORE_EXPLANATIONS: Record<string, { category: string; description: string }> = {
  "avg-ttft": { category: "Response Time", description: "Average time to first token (in seconds)" },
  "usr-questions": { category: "Questions", description: "Total number of questions asked by the user" },
  "bot-avg-words": { category: "Word Count", description: "Average number of words per bot message" },
  // ... more score definitions
};
```

## Internal Thoughts Feature

**Component:** [`web/src/features/conversations/conversation-view/InternalThoughts.tsx`](web/src/features/conversations/conversation-view/InternalThoughts.tsx)

Displays AI internal thinking/reasoning data fetched from Supabase. The component:
- Toggles visibility with a "Show/Hide Internal Thoughts" button
- Fetches thoughts by `threadId` + `messageId` (new format) or by `messageText` (legacy fallback)
- Displays structured JSON fields: `new_parsed_information`, `next_step_in_session`, `knowledge_for_next_step`

## DjbView Component

**File:** [`web/src/components/ui/DjbView.tsx`](web/src/components/ui/DjbView.tsx)

A custom markdown rendering component that:
- Renders markdown with syntax highlighting (GFM support)
- Handles OpenAI content parts (text, images, audio)
- Provides copy-to-clipboard functionality
- Supports multi-modal content display
- Includes safe URL sanitization for links

## Global Configuration System

**File:** [`web/src/server/global-config.ts`](web/src/server/global-config.ts)

A singleton class for managing runtime configurations:

```typescript
interface SupabaseConfig {
  url: string;
  serviceRoleKey: string;
}

interface DjbBackendConfig {
  url: string;
  authKey: string;
}

// Usage
globalConfig.setSupabaseConfig(config);
globalConfig.getDjbBackendConfig();
```

**Features:**
- Runtime switching between Supabase configurations
- Fallback to environment variables when no custom config is set
- Separate management for Supabase and DJB backend configs

## Backend Integrations

### DJB Backend Support

**Environment Variables:**

```bash
# DJB Backend Configuration
DJB_BACKEND_URL=http://localhost:8000  # Default fallback
DJB_BACKEND_AUTH_KEY=dev               # Authentication key

# Supabase Configuration
SUPABASE_URL=<supabase_url>
SUPABASE_SERVICE_ROLE_KEY=<service_role_key>
```

### Backend Notification Endpoints

The accounts router provides several backend notification functions:

- `notifyBackendToCreateSnapshotUser` - POST to `/admin/user_clone`
- `notifyBackendToGenerateConversation` - POST to `/admin/synthetic_conversation`
- `notifyBackendToReplayThread` - POST to `/admin/thread_replay`

## Database Schema Extensions

### User Metadata Structure

The system extends the standard User model with custom `djb_metadata`:

```typescript
// For Synthetic Users
djb_metadata: {
  synthetic: {
    prompt_name: string,
    notes: string,
  }
}

// For Snapshot Users  
djb_metadata: {
  snapshot: {
    session_id: string,
    turn_number: number,
    context_data: object,
  }
}
```

### Test Users Table

Additional table for synthetic user authentication:
```sql
test_users (
  id: string,
  username: string, 
  password: string (hashed)
)
```

## Usage Guide

### Creating Synthetic Users

1. Navigate to **Accounts** → **Synthetic Users** tab
2. Click **Create Synthetic User**
3. Provide username and notes
4. System auto-generates:
   - Username with `synth_` prefix
   - Associated prompt template
   - Test user credentials

### Using the Scoring System

1. Open any conversation view
2. Use the scoring interface on each message
3. Select from predefined score categories
4. Scores are color-coded and saved per user
5. Add comments for additional context

### Conversation Replay

1. Go to **Conversations** table
2. Click **Replay** button on any conversation
3. Enter target username for replay
4. System extracts conversation UUID and initiates replay

## Technical Implementation

### Key Technologies
- **Frontend**: Next.js with TypeScript
- **Backend**: TRPC for type-safe APIs
- **Database**: Postgres (Supabase) + ClickHouse
- **UI**: Shadcn/ui components with custom styling
- **Authentication**: Custom user type management

### Code Structure

```text
web/src/
├── components/
│   └── ui/
│       └── DjbView.tsx              # Custom markdown renderer
├── features/
│   ├── accounts/                     # User management system
│   │   ├── synthetic/               # Synthetic user components
│   │   ├── snapshot/                # Snapshot user components
│   │   └── server/
│   │       ├── accounts.router.ts   # TRPC router
│   │       └── synthetic-prompt-template.ts
│   └── conversations/               # Conversation analytics
│       ├── conversation-view/       # Scoring and viewing
│       │   ├── ConversationView.tsx
│       │   ├── InternalThoughts.tsx # AI thinking display
│       │   ├── MessageScores.tsx
│       │   ├── RecentConversations.tsx
│       │   ├── score-config.ts
│       │   ├── score-colors.ts
│       │   └── conversation-view.router.ts
│       ├── conversation-summary/    # Analytics dashboard
│       │   └── ConversationSummaryPage.tsx
│       └── server/                  # Conversation services
├── pages/
│   └── project/[projectId]/
│       ├── accounts/index.tsx
│       └── conversations/
│           ├── index.tsx
│           ├── [conversationId]/index.tsx
│           └── summary/[conversationId].tsx
└── server/
    ├── global-config.ts             # Runtime config management
    └── supabase.ts                  # Supabase client
```

### API Endpoints

**Accounts Router:**
- `accounts.getUsers` - Real users
- `accounts.getSyntheticUsers` - Synthetic users
- `accounts.getSnapshotUsers` - Snapshot users
- `accounts.createUser` - Create a new real user with Supabase auth
- `accounts.createSyntheticUser` - Create synthetic user with prompt
- `accounts.updateSyntheticUser` - Update synthetic user metadata
- `accounts.createSnapshotUser` - Create snapshot user from conversation context
- `accounts.generateConversation` - Trigger conversation generation for synthetic user
- `accounts.threadReplay` - Replay conversations
- `accounts.updateUser` - Update user credentials
- `accounts.deleteUser` - Delete user from system

**Conversations Router:**
- `conversation.getSessionTraces` - Get conversation messages
- `conversation.getRecentConversationsForUser` - User conversation history
- `conversation.getScoresForTraces` - Get all scores for given trace IDs
- `conversation.upsertScore` - Create/update scores
- `conversation.deleteScore` - Delete scores
- `conversation.getInternalThoughts` - Fetch AI thinking data from Supabase

## Development Notes

### Environment Setup

The OMAI features require additional environment variables for:

- DJB backend integration
- Multiple Supabase connections
- Synthetic user credentials

### Feature Flags

Some OMAI features are controlled by:

- Project admin permissions
- User role checks
- Environment-specific configurations

### Testing

- Synthetic users use hardcoded passwords for testing
- Snapshot users are automatically generated
- Conversation replay supports development/production environments

---

## Recent Changes Summary

Based on git history analysis, the most recent feature developments include:

1. **OMAI-1477**: Tab-based user type navigation
2. **OMAI-1472**: Custom scoring system implementation  
3. **OMAI-1476**: Enhanced conversation view with recent conversations
4. **OMAI-1473**: New sidebar sections and routing

For detailed commit history, see git log with `--author="David Halapir"` and `--author="Adrian Punkt"`.

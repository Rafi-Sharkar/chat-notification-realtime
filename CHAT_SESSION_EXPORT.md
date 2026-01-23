# Chat Session Export - January 23, 2026

## yousef-server Project Debugging & Socket.IO Explanation

---

## Session Overview

**Objective:** Fix `pnpm dev` compilation errors and understand the private-message Socket.IO system.

**Outcome:** ✅ Successfully fixed all 236+ TypeScript errors, server running on localhost:3000

---

## Part 1: Bug Fixes & Package Changes

### 1. @nestjs/swagger Upgrade

**Problem:** Version 2.5.1 was too old, missing modern decorators like `ApiProperty`, `ApiTags`, `summary` option.

**Solution:** Upgraded from 2.5.1 → 11.2.5

```bash
pnpm remove @nestjs/swagger
pnpm add @nestjs/swagger@11.2.5
```

### 2. Swagger Config Fix

**File:** `src/swagger/swagger.config.ts`

**Problem:** Invalid method `addSecurityRequirements` doesn't exist.

**Solution:** Removed the invalid method call.

### 3. Prisma Downgrade (7.3.0 → 5.22.0)

**Problem:** Prisma 7.x requires `adapter` or `accelerateUrl` configuration which wasn't set up.

**Solution:** Downgraded to stable Prisma 5.22.0

```bash
pnpm remove prisma @prisma/client
pnpm add prisma@5.22.0 @prisma/client@5.22.0
```

### 4. prisma.config.ts Removal

**Problem:** `prisma.config.ts` is Prisma 7.x specific.

**Solution:** Renamed to `prisma.config.ts.bak`

### 5. ULID → CUID Change

**File:** `prisma/schema/general-setting.prisma`

**Problem:** `@default(ulid())` not supported in Prisma 5.

**Solution:** Changed to `@default(cuid())`

### 6. Omit → Select Change

**File:** `src/main/garage-admin/subscription/subscription.service.ts`

**Problem:** `omit` option had issues in Prisma 5.

**Solution:** Changed from `omit: { garage: true }` to explicit `select` with all needed fields.

### 7. TranslationService Optional API Key

**File:** `src/lib/translation/translation.service.ts`

**Problem:** Service crashed if `GOOGLE_TRANSLATE_API_KEY` was not set.

**Solution:** Made the API key optional with graceful fallback:

```typescript
private isInitialized = false;

constructor(@Inject(ConfigService) private readonly configService: ConfigService) {
  const apiKey = this.configService.get<string>('GOOGLE_TRANSLATE_API_KEY');
  if (apiKey) {
    this.translate = new Translate({ key: apiKey });
    this.isInitialized = true;
  }
}

async translateText(text: string, targetLang: string): Promise<string> {
  if (!this.isInitialized) {
    return text; // Return original text if not initialized
  }
  // ... rest of translation logic
}
```

### 8. JsonValue Import Fix

**File:** `src/common/interface/notification-payload.ts`

**Problem:** `JsonValue` import from `@prisma/client/runtime/library` failed.

**Solution:** Changed to import from `@prisma/client`:

```typescript
import { Prisma } from '@prisma/client';
// Use Prisma.JsonValue instead of JsonValue
```

---

## Part 2: Socket.IO Private Message System Explanation

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    PRIVATE MESSAGE MODULE                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   Controller    │  │    Service      │  │   Gateway   │ │
│  │   (REST API)    │  │  (Business      │  │  (WebSocket)│ │
│  │                 │  │   Logic)        │  │             │ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘ │
│           │                    │                   │        │
│           └────────────────────┼───────────────────┘        │
│                                │                            │
│                    ┌───────────▼───────────┐                │
│                    │    Prisma Service     │                │
│                    │    (Database)         │                │
│                    └───────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

### Database Schema

```prisma
model PrivateConversation {
  id            String   @id @default(cuid())
  user1Id       String
  user2Id       String
  lastMessageId String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  user1       User             @relation("User1Conversations", fields: [user1Id])
  user2       User             @relation("User2Conversations", fields: [user2Id])
  lastMessage PrivateMessage?  @relation("LastMessage", fields: [lastMessageId])
  messages    PrivateMessage[] @relation("ConversationMessages")

  @@unique([user1Id, user2Id])
}

model PrivateMessage {
  id             String   @id @default(cuid())
  content        String?
  senderId       String
  conversationId String
  replyToId      String?
  isRead         Boolean  @default(false)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  sender         User                @relation(fields: [senderId])
  conversation   PrivateConversation @relation("ConversationMessages", fields: [conversationId])
  replyTo        PrivateMessage?     @relation("MessageReplies", fields: [replyToId])
  replies        PrivateMessage[]    @relation("MessageReplies")
  files          FileInstance[]
  lastMessageFor PrivateConversation[] @relation("LastMessage")
}
```

### Gateway (WebSocket Handler)

**File:** `src/main/shared/private-message/privateChatGateway/privateChatGateway.ts`

**Namespace:** `/pv/message`

**Key Events:**

| Event           | Direction       | Purpose                         |
| --------------- | --------------- | ------------------------------- |
| `SEND_MESSAGE`  | Client → Server | Send a new message              |
| `NEW_MESSAGE`   | Server → Client | Notify recipient of new message |
| `SUCCESS`       | Server → Client | Confirm action succeeded        |
| `ERROR`         | Server → Client | Notify of errors                |
| `TYPING`        | Client → Server | User is typing                  |
| `STOP_TYPING`   | Client → Server | User stopped typing             |
| `TYPING_STATUS` | Server → Client | Notify typing status            |
| `MARK_AS_READ`  | Client → Server | Mark messages as read           |
| `MESSAGE_READ`  | Server → Client | Notify message was read         |

**Connection Authentication:**

```typescript
async handleConnection(client: Socket) {
  try {
    const token = client.handshake.auth.token ||
                  client.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      throw new WsException('Authentication token missing');
    }

    const payload = await this.jwtService.verifyAsync(token, {
      secret: this.configService.get<string>('JWT_SECRET'),
    });

    client.data.user = payload;

    // Join personal room for receiving messages
    client.join(`user_${payload.sub}`);

    client.emit(PrivateChatEvents.SUCCESS, {
      message: 'Connected to private chat',
    });
  } catch (error) {
    client.emit(PrivateChatEvents.ERROR, {
      message: 'Authentication failed',
    });
    client.disconnect();
  }
}
```

**Send Message Handler:**

```typescript
@SubscribeMessage(PrivateChatEvents.SEND_MESSAGE)
async handleSendMessage(
  @ConnectedSocket() client: Socket,
  @MessageBody() payload: SendPrivateMessageDto,
) {
  const senderId = client.data.user.sub;

  // 1. Find or create conversation
  let conversation = await this.privateChatService.findConversation(
    senderId,
    payload.recipientId,
  );

  if (!conversation) {
    conversation = await this.privateChatService.createConversation(
      senderId,
      payload.recipientId,
    );
  }

  // 2. Save message to database
  const message = await this.privateChatService.sendPrivateMessage({
    senderId,
    conversationId: conversation.id,
    content: payload.content,
    files: payload.files,
    replyToMessageId: payload.replyToMessageId,
  });

  // 3. Emit to recipient's room
  this.server.to(`user_${payload.recipientId}`).emit(
    PrivateChatEvents.NEW_MESSAGE,
    message,
  );

  // 4. Confirm to sender
  client.emit(PrivateChatEvents.SUCCESS, {
    message: 'Message sent successfully',
    data: message,
  });
}
```

### Message Flow Diagram

```
USER A (Sender)                    SERVER                     USER B (Recipient)
     │                               │                              │
     │  1. Connect with JWT token    │                              │
     │──────────────────────────────>│                              │
     │                               │                              │
     │  2. SUCCESS: "Connected"      │                              │
     │<──────────────────────────────│                              │
     │                               │                              │
     │                               │   1. Connect with JWT token  │
     │                               │<─────────────────────────────│
     │                               │                              │
     │                               │   2. SUCCESS: "Connected"    │
     │                               │─────────────────────────────>│
     │                               │                              │
     │  3. SEND_MESSAGE {            │                              │
     │     recipientId: "B",         │                              │
     │     content: "Hello!"         │                              │
     │  }                            │                              │
     │──────────────────────────────>│                              │
     │                               │                              │
     │                               │  (Server saves to database)  │
     │                               │                              │
     │                               │   4. NEW_MESSAGE {           │
     │                               │      id, content, sender...  │
     │                               │   }                          │
     │                               │─────────────────────────────>│
     │                               │                              │
     │  5. SUCCESS: "Message sent"   │                              │
     │<──────────────────────────────│                              │
     │                               │                              │
```

### Frontend Usage Example

```typescript
import { io, Socket } from 'socket.io-client';

class PrivateChatClient {
  private socket: Socket;

  connect(token: string) {
    this.socket = io('http://localhost:3000/pv/message', {
      auth: { token },
    });

    // Listen for events
    this.socket.on('SUCCESS', (data) => {
      console.log('Success:', data);
    });

    this.socket.on('ERROR', (data) => {
      console.error('Error:', data);
    });

    this.socket.on('NEW_MESSAGE', (message) => {
      console.log('New message received:', message);
      this.displayMessage(message);
    });

    this.socket.on('TYPING_STATUS', (data) => {
      if (data.isTyping) {
        this.showTypingIndicator(data.userId);
      } else {
        this.hideTypingIndicator(data.userId);
      }
    });

    this.socket.on('MESSAGE_READ', (data) => {
      this.markMessageAsRead(data.messageId);
    });
  }

  sendMessage(recipientId: string, content: string) {
    this.socket.emit('SEND_MESSAGE', {
      recipientId,
      content,
    });
  }

  startTyping(recipientId: string) {
    this.socket.emit('TYPING', { recipientId });
  }

  stopTyping(recipientId: string) {
    this.socket.emit('STOP_TYPING', { recipientId });
  }

  markAsRead(messageId: string, senderId: string) {
    this.socket.emit('MARK_AS_READ', { messageId, senderId });
  }

  disconnect() {
    this.socket.disconnect();
  }
}

// Usage
const chat = new PrivateChatClient();
chat.connect('your-jwt-token');
chat.sendMessage('recipient-user-id', 'Hello!');
```

### REST API Endpoints

| Method | Endpoint                        | Purpose                                   |
| ------ | ------------------------------- | ----------------------------------------- |
| GET    | `/private-chat`                 | Get all conversations for current user    |
| GET    | `/private-chat/:conversationId` | Get messages in a conversation            |
| POST   | `/private-chat/send`            | Send a message (alternative to WebSocket) |

---

## Final State

### Package Versions

- `@nestjs/swagger`: 11.2.5
- `prisma`: 5.22.0
- `@prisma/client`: 5.22.0

### Server Status

- ✅ Compilation: 0 errors
- ✅ Running on: http://localhost:3000
- ✅ Swagger Docs: http://localhost:3000/docs

### Key Files Modified

1. `src/swagger/swagger.config.ts` - Removed invalid method
2. `src/lib/translation/translation.service.ts` - Optional API key
3. `src/common/interface/notification-payload.ts` - Fixed import
4. `src/main/garage-admin/subscription/subscription.service.ts` - omit → select
5. `prisma/schema/general-setting.prisma` - ulid → cuid
6. `prisma.config.ts` → `prisma.config.ts.bak` - Disabled Prisma 7 config

---

---

# Complete Guide: One-to-One Private Chat with Socket.IO in NestJS

## 🎯 Introduction

This guide explains how the **one-to-one private messaging system** works in this NestJS project using **Socket.IO**. Perfect for beginners who want to understand real-time chat systems.

---

## 📚 Table of Contents

1. [What is Socket.IO?](#1-what-is-socketio)
2. [Project Structure](#2-project-structure)
3. [Database Schema (Prisma)](#3-database-schema-prisma)
4. [The Gateway - Heart of WebSocket](#4-the-gateway---heart-of-websocket)
5. [The Service - Business Logic](#5-the-service---business-logic)
6. [The Controller - REST API](#6-the-controller---rest-api)
7. [DTOs - Data Transfer Objects](#7-dtos---data-transfer-objects)
8. [Complete Message Flow](#8-complete-message-flow)
9. [Frontend Integration Guide](#9-frontend-integration-guide)
10. [Key Concepts Explained](#10-key-concepts-explained)

---

## 1. What is Socket.IO?

### Traditional HTTP vs WebSocket

```
┌─────────────────────────────────────────────────────────────────┐
│                    TRADITIONAL HTTP (REST)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Client                              Server                     │
│     │                                   │                        │
│     │──── Request: "Any new messages?"──>│                       │
│     │<─── Response: "No" ────────────────│                       │
│     │                                   │                        │
│     │──── Request: "Any new messages?"──>│  (Polling every 5s)  │
│     │<─── Response: "No" ────────────────│                       │
│     │                                   │                        │
│     │──── Request: "Any new messages?"──>│                       │
│     │<─── Response: "Yes! Here's one" ───│                       │
│                                                                  │
│   ❌ Problem: Wasteful! Many unnecessary requests                │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                    WEBSOCKET (Socket.IO)                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Client                              Server                     │
│     │                                   │                        │
│     │════ Persistent Connection ════════│  (Always connected)   │
│     │                                   │                        │
│     │                                   │  (New message arrives) │
│     │<═══ "NEW_MESSAGE: Hello!" ════════│  (Instant push!)      │
│     │                                   │                        │
│     │═══ "SEND_MESSAGE: Hi back!" ═════>│                       │
│     │                                   │                        │
│                                                                  │
│   ✅ Benefit: Real-time, efficient, bidirectional               │
└─────────────────────────────────────────────────────────────────┘
```

### Why Socket.IO?

| Feature     | HTTP REST                 | Socket.IO                         |
| ----------- | ------------------------- | --------------------------------- |
| Connection  | Opens/closes each request | Stays open                        |
| Direction   | Client → Server only      | Bidirectional                     |
| Real-time   | No (needs polling)        | Yes (instant)                     |
| Server Push | Not possible              | Built-in                          |
| Best for    | CRUD operations           | Chat, notifications, live updates |

---

## 2. Project Structure

```
src/main/shared/private-message/
├── private-message.module.ts       # Module registration
├── private-message.controller.ts   # REST API endpoints
├── private-message.service.ts      # Business logic & DB operations
└── privateChatGateway/
    ├── privateChatGateway.ts       # WebSocket Gateway (main file)
    └── privateChatGateway.dto.ts   # Data Transfer Objects
```

### How They Work Together

```
┌──────────────────────────────────────────────────────────────────────┐
│                         CLIENT (Browser/App)                          │
└───────────────┬────────────────────────────────────┬─────────────────┘
                │                                    │
        WebSocket Connection                   HTTP Requests
        (Real-time events)                    (REST API calls)
                │                                    │
                ▼                                    ▼
┌───────────────────────────┐          ┌───────────────────────────┐
│        GATEWAY            │          │       CONTROLLER          │
│   privateChatGateway.ts   │          │ private-message.controller│
│                           │          │                           │
│ • handleConnection()      │          │ • GET /private-chat       │
│ • handleSendMessage()     │          │ • GET /private-chat/:id   │
│ • handleTyping()          │          │ • POST /private-chat/send │
│ • handleMarkAsRead()      │          │                           │
└───────────────┬───────────┘          └───────────────┬───────────┘
                │                                      │
                │         ┌────────────────┐          │
                └────────>│    SERVICE     │<─────────┘
                          │ private-message│
                          │   .service.ts  │
                          │                │
                          │ • sendPrivate  │
                          │   Message()    │
                          │ • findConver-  │
                          │   sation()     │
                          │ • createConver-│
                          │   sation()     │
                          │ • getUserConv- │
                          │   ersations()  │
                          └───────┬────────┘
                                  │
                                  ▼
                          ┌────────────────┐
                          │  PRISMA ORM    │
                          │  (Database)    │
                          └────────────────┘
```

---

## 3. Database Schema (Prisma)

### File: `prisma/schema/private-message.prisma`

```prisma
// ═══════════════════════════════════════════════════════════════
// PRIVATE CONVERSATION - Container for messages between 2 users
// ═══════════════════════════════════════════════════════════════
model PrivateConversation {
  id            String   @id @default(cuid())    // Unique ID
  user1Id       String                            // First participant
  user2Id       String                            // Second participant
  lastMessageId String?  @unique                  // Quick access to latest message
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  // Relations
  user1       User             @relation("User1Conversations", fields: [user1Id], references: [id])
  user2       User             @relation("User2Conversations", fields: [user2Id], references: [id])
  lastMessage PrivateMessage?  @relation("LastMessage", fields: [lastMessageId], references: [id], onDelete: SetNull, onUpdate: NoAction)
  messages    PrivateMessage[] @relation("ConversationMessages")

  // Ensure only ONE conversation between any 2 users
  @@unique([user1Id, user2Id])
}

// ═══════════════════════════════════════════════════════════════
// PRIVATE MESSAGE - Individual message in a conversation
// ═══════════════════════════════════════════════════════════════
model PrivateMessage {
  id             String   @id @default(cuid())
  content        String?                          // Message text (optional if file-only)
  senderId       String                           // Who sent it
  conversationId String                           // Which conversation
  replyToId      String?                          // Reply to another message (optional)
  isRead         Boolean  @default(false)         // Read receipt
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  // Relations
  sender         User                @relation("SenderMessages", fields: [senderId], references: [id])
  conversation   PrivateConversation @relation("ConversationMessages", fields: [conversationId], references: [id], onDelete: Cascade)
  replyTo        PrivateMessage?     @relation("MessageReplies", fields: [replyToId], references: [id], onDelete: SetNull, onUpdate: NoAction)
  replies        PrivateMessage[]    @relation("MessageReplies")
  files          FileInstance[]      @relation("PrivateMessageFiles")
  lastMessageFor PrivateConversation? @relation("LastMessage")

  @@index([conversationId])
  @@index([senderId])
}
```

### Visual Representation

```
┌─────────────────────────────────────────────────────────────────┐
│                    PrivateConversation                           │
│  id: "conv_123"                                                  │
│  user1Id: "alice_id"  ◄─────┐                                   │
│  user2Id: "bob_id"    ◄─────┼──── The two participants          │
│  lastMessageId: "msg_456"   │                                   │
└─────────────────────────────┼───────────────────────────────────┘
                              │
                              │ has many
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PrivateMessage (1)                            │
│  id: "msg_123"                                                   │
│  content: "Hey Bob!"                                             │
│  senderId: "alice_id"                                            │
│  conversationId: "conv_123"                                      │
│  isRead: true                                                    │
└─────────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│                    PrivateMessage (2)                            │
│  id: "msg_456"                                                   │
│  content: "Hi Alice!"                                            │
│  senderId: "bob_id"                                              │
│  conversationId: "conv_123"                                      │
│  isRead: false                                                   │
│  replyToId: "msg_123"  ◄──── This is a reply to Alice's message │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. The Gateway - Heart of WebSocket

### File: `src/main/shared/private-message/privateChatGateway/privateChatGateway.ts`

### What is a Gateway?

A **Gateway** in NestJS is like a controller, but for WebSocket connections instead of HTTP requests.

```typescript
// ═══════════════════════════════════════════════════════════════
// GATEWAY DECORATOR - Configures the WebSocket server
// ═══════════════════════════════════════════════════════════════
@WebSocketGateway({
  namespace: '/pv/message',     // URL path: ws://localhost:3000/pv/message
  cors: {
    origin: '*',                // Allow all origins (configure for production!)
    credentials: true,
  },
})
export class PrivateChatGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect
{
  // ═══════════════════════════════════════════════════════════════
  // SERVER INSTANCE - Used to emit events to clients
  // ═══════════════════════════════════════════════════════════════
  @WebSocketServer()
  server: Server;  // This is the Socket.IO server instance

  // ═══════════════════════════════════════════════════════════════
  // DEPENDENCY INJECTION - Services we need
  // ═══════════════════════════════════════════════════════════════
  constructor(
    private readonly privateChatService: PrivateChatService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}
```

### Lifecycle Hooks Explained

```typescript
// ═══════════════════════════════════════════════════════════════
// 1. AFTER INIT - Called once when gateway starts
// ═══════════════════════════════════════════════════════════════
afterInit(server: Server) {
  console.log('Private Chat Gateway Initialized');
  // Good place for: logging, metrics setup
}

// ═══════════════════════════════════════════════════════════════
// 2. HANDLE CONNECTION - Called when a client connects
// ═══════════════════════════════════════════════════════════════
async handleConnection(client: Socket) {
  try {
    // Step 1: Extract JWT token from connection
    const token = client.handshake.auth.token ||
                  client.handshake.headers.authorization?.split(' ')[1];

    if (!token) {
      throw new WsException('Authentication token missing');
    }

    // Step 2: Verify the token
    const payload = await this.jwtService.verifyAsync(token, {
      secret: this.configService.get<string>('JWT_SECRET'),
    });

    // Step 3: Store user info on the socket
    client.data.user = payload;

    // Step 4: Join a personal "room" for receiving messages
    // Room name format: "user_<userId>"
    client.join(`user_${payload.sub}`);

    // Step 5: Notify client of successful connection
    client.emit(PrivateChatEvents.SUCCESS, {
      message: 'Connected to private chat',
    });

    console.log(`User ${payload.sub} connected to private chat`);
  } catch (error) {
    // Authentication failed - disconnect the client
    client.emit(PrivateChatEvents.ERROR, {
      message: 'Authentication failed',
    });
    client.disconnect();
  }
}

// ═══════════════════════════════════════════════════════════════
// 3. HANDLE DISCONNECT - Called when a client disconnects
// ═══════════════════════════════════════════════════════════════
handleDisconnect(client: Socket) {
  console.log(`Client disconnected: ${client.id}`);
  // Good place for: cleanup, status updates, logging
}
```

### Understanding Rooms

```
┌─────────────────────────────────────────────────────────────────┐
│                    SOCKET.IO ROOMS CONCEPT                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  When Alice connects:                                            │
│    client.join('user_alice123')                                  │
│                                                                  │
│  When Bob connects:                                              │
│    client.join('user_bob456')                                    │
│                                                                  │
│  ┌──────────────────┐     ┌──────────────────┐                  │
│  │ Room:            │     │ Room:            │                  │
│  │ user_alice123    │     │ user_bob456      │                  │
│  │                  │     │                  │                  │
│  │  ┌────────────┐  │     │  ┌────────────┐  │                  │
│  │  │  Alice's   │  │     │  │   Bob's    │  │                  │
│  │  │  Socket    │  │     │  │  Socket    │  │                  │
│  │  └────────────┘  │     │  └────────────┘  │                  │
│  └──────────────────┘     └──────────────────┘                  │
│                                                                  │
│  To send a message to Bob:                                       │
│    server.to('user_bob456').emit('NEW_MESSAGE', message)        │
│                                                                  │
│  This sends ONLY to Bob's room (Bob's socket receives it)       │
└─────────────────────────────────────────────────────────────────┘
```

### Event Handlers

```typescript
// ═══════════════════════════════════════════════════════════════
// SEND MESSAGE - When client emits 'SEND_MESSAGE'
// ═══════════════════════════════════════════════════════════════
@SubscribeMessage(PrivateChatEvents.SEND_MESSAGE)
async handleSendMessage(
  @ConnectedSocket() client: Socket,           // The sender's socket
  @MessageBody() payload: SendPrivateMessageDto, // Message data
) {
  try {
    // Get sender's ID from the authenticated socket
    const senderId = client.data.user.sub;

    // Step 1: Find existing conversation OR create new one
    let conversation = await this.privateChatService.findConversation(
      senderId,
      payload.recipientId,
    );

    if (!conversation) {
      conversation = await this.privateChatService.createConversation(
        senderId,
        payload.recipientId,
      );
    }

    // Step 2: Save the message to database
    const message = await this.privateChatService.sendPrivateMessage({
      senderId,
      conversationId: conversation.id,
      content: payload.content,
      files: payload.files,
      replyToMessageId: payload.replyToMessageId,
    });

    // Step 3: Send to recipient's room (real-time delivery!)
    this.server
      .to(`user_${payload.recipientId}`)
      .emit(PrivateChatEvents.NEW_MESSAGE, message);

    // Step 4: Confirm to sender
    client.emit(PrivateChatEvents.SUCCESS, {
      message: 'Message sent successfully',
      data: message,
    });
  } catch (error) {
    client.emit(PrivateChatEvents.ERROR, {
      message: 'Failed to send message',
      error: error.message,
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// TYPING INDICATOR - When user starts typing
// ═══════════════════════════════════════════════════════════════
@SubscribeMessage(PrivateChatEvents.TYPING)
handleTyping(
  @ConnectedSocket() client: Socket,
  @MessageBody() payload: { recipientId: string },
) {
  const userId = client.data.user.sub;

  // Notify the recipient that this user is typing
  this.server.to(`user_${payload.recipientId}`).emit(
    PrivateChatEvents.TYPING_STATUS,
    {
      userId,
      isTyping: true,
    },
  );
}

// ═══════════════════════════════════════════════════════════════
// STOP TYPING - When user stops typing
// ═══════════════════════════════════════════════════════════════
@SubscribeMessage(PrivateChatEvents.STOP_TYPING)
handleStopTyping(
  @ConnectedSocket() client: Socket,
  @MessageBody() payload: { recipientId: string },
) {
  const userId = client.data.user.sub;

  this.server.to(`user_${payload.recipientId}`).emit(
    PrivateChatEvents.TYPING_STATUS,
    {
      userId,
      isTyping: false,
    },
  );
}

// ═══════════════════════════════════════════════════════════════
// MARK AS READ - When user reads a message
// ═══════════════════════════════════════════════════════════════
@SubscribeMessage(PrivateChatEvents.MARK_AS_READ)
async handleMarkAsRead(
  @ConnectedSocket() client: Socket,
  @MessageBody() payload: { messageId: string; senderId: string },
) {
  try {
    // Update message in database
    await this.privateChatService.markMessageAsRead(payload.messageId);

    // Notify the original sender that their message was read
    this.server.to(`user_${payload.senderId}`).emit(
      PrivateChatEvents.MESSAGE_READ,
      {
        messageId: payload.messageId,
        readBy: client.data.user.sub,
        readAt: new Date(),
      },
    );
  } catch (error) {
    client.emit(PrivateChatEvents.ERROR, {
      message: 'Failed to mark message as read',
    });
  }
}
```

### Events Reference

```typescript
// ═══════════════════════════════════════════════════════════════
// ALL EVENTS DEFINED IN THE SYSTEM
// ═══════════════════════════════════════════════════════════════
export enum PrivateChatEvents {
  // Error & Success (Server → Client)
  ERROR = 'ERROR',
  SUCCESS = 'SUCCESS',

  // Messaging
  SEND_MESSAGE = 'SEND_MESSAGE', // Client → Server: Send new message
  NEW_MESSAGE = 'NEW_MESSAGE', // Server → Client: Receive new message

  // Typing Indicators
  TYPING = 'TYPING', // Client → Server: Started typing
  STOP_TYPING = 'STOP_TYPING', // Client → Server: Stopped typing
  TYPING_STATUS = 'TYPING_STATUS', // Server → Client: Typing status update

  // Read Receipts
  MARK_AS_READ = 'MARK_AS_READ', // Client → Server: Message was read
  MESSAGE_READ = 'MESSAGE_READ', // Server → Client: Your message was read

  // Deletion
  DELETE_MESSAGE = 'DELETE_MESSAGE', // Client → Server: Delete a message
  MESSAGE_DELETED = 'MESSAGE_DELETED', // Server → Client: Message was deleted
}
```

---

## 5. The Service - Business Logic

### File: `src/main/shared/private-message/private-message.service.ts`

```typescript
@Injectable()
export class PrivateChatService {
  constructor(private readonly prisma: PrismaService) {}

  // ═══════════════════════════════════════════════════════════════
  // FIND CONVERSATION - Check if conversation exists between 2 users
  // ═══════════════════════════════════════════════════════════════
  async findConversation(userId1: string, userId2: string) {
    // Check both orderings since user1/user2 order might vary
    return this.prisma.privateConversation.findFirst({
      where: {
        OR: [
          { user1Id: userId1, user2Id: userId2 },
          { user1Id: userId2, user2Id: userId1 },
        ],
      },
      include: {
        user1: { select: { id: true, name: true, profileImage: true } },
        user2: { select: { id: true, name: true, profileImage: true } },
        lastMessage: true,
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // CREATE CONVERSATION - Start new conversation between 2 users
  // ═══════════════════════════════════════════════════════════════
  async createConversation(userId1: string, userId2: string) {
    return this.prisma.privateConversation.create({
      data: {
        user1Id: userId1,
        user2Id: userId2,
      },
      include: {
        user1: { select: { id: true, name: true, profileImage: true } },
        user2: { select: { id: true, name: true, profileImage: true } },
      },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SEND MESSAGE - Save a new message to the database
  // ═══════════════════════════════════════════════════════════════
  async sendPrivateMessage(data: {
    senderId: string;
    conversationId: string;
    content?: string;
    files?: string[];
    replyToMessageId?: string;
  }) {
    // Step 1: Create the message
    const message = await this.prisma.privateMessage.create({
      data: {
        content: data.content,
        senderId: data.senderId,
        conversationId: data.conversationId,
        replyToId: data.replyToMessageId,
        // Connect files if provided
        files: data.files?.length
          ? {
              connect: data.files.map((fileId) => ({ id: fileId })),
            }
          : undefined,
      },
      include: {
        sender: { select: { id: true, name: true, profileImage: true } },
        files: true,
        replyTo: {
          include: {
            sender: { select: { id: true, name: true } },
          },
        },
      },
    });

    // Step 2: Update conversation's lastMessage
    await this.prisma.privateConversation.update({
      where: { id: data.conversationId },
      data: { lastMessageId: message.id },
    });

    return message;
  }

  // ═══════════════════════════════════════════════════════════════
  // GET USER CONVERSATIONS - List all conversations for a user
  // ═══════════════════════════════════════════════════════════════
  async getUserConversations(userId: string) {
    return this.prisma.privateConversation.findMany({
      where: {
        OR: [{ user1Id: userId }, { user2Id: userId }],
      },
      include: {
        user1: { select: { id: true, name: true, profileImage: true } },
        user2: { select: { id: true, name: true, profileImage: true } },
        lastMessage: {
          include: {
            sender: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // GET CONVERSATION MESSAGES - Get all messages in a conversation
  // ═══════════════════════════════════════════════════════════════
  async getConversationMessages(
    conversationId: string,
    options?: { skip?: number; take?: number },
  ) {
    return this.prisma.privateMessage.findMany({
      where: { conversationId },
      include: {
        sender: { select: { id: true, name: true, profileImage: true } },
        files: true,
        replyTo: {
          include: {
            sender: { select: { id: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      skip: options?.skip,
      take: options?.take,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // MARK MESSAGE AS READ - Update read status
  // ═══════════════════════════════════════════════════════════════
  async markMessageAsRead(messageId: string) {
    return this.prisma.privateMessage.update({
      where: { id: messageId },
      data: { isRead: true },
    });
  }
}
```

---

## 6. The Controller - REST API

### File: `src/main/shared/private-message/private-message.controller.ts`

```typescript
@ApiTags('Private Chat')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('private-chat')
export class PrivateChatController {
  constructor(private readonly privateChatService: PrivateChatService) {}

  // ═══════════════════════════════════════════════════════════════
  // GET ALL CONVERSATIONS - List user's chat threads
  // ═══════════════════════════════════════════════════════════════
  @Get()
  @ApiOperation({ summary: 'Get all conversations for current user' })
  async getConversations(@Req() req: RequestWithUser) {
    const userId = req.user.sub;
    return this.privateChatService.getUserConversations(userId);
  }

  // ═══════════════════════════════════════════════════════════════
  // GET MESSAGES - Get messages in a specific conversation
  // ═══════════════════════════════════════════════════════════════
  @Get(':conversationId')
  @ApiOperation({ summary: 'Get messages in a conversation' })
  async getMessages(
    @Param('conversationId') conversationId: string,
    @Query('skip') skip?: number,
    @Query('take') take?: number,
  ) {
    return this.privateChatService.getConversationMessages(conversationId, {
      skip: skip ? +skip : undefined,
      take: take ? +take : undefined,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SEND MESSAGE (REST) - Alternative to WebSocket
  // ═══════════════════════════════════════════════════════════════
  @Post('send')
  @ApiOperation({ summary: 'Send a private message' })
  async sendMessage(
    @Req() req: RequestWithUser,
    @Body() body: SendPrivateMessageDto,
  ) {
    const senderId = req.user.sub;

    let conversation = await this.privateChatService.findConversation(
      senderId,
      body.recipientId,
    );

    if (!conversation) {
      conversation = await this.privateChatService.createConversation(
        senderId,
        body.recipientId,
      );
    }

    return this.privateChatService.sendPrivateMessage({
      senderId,
      conversationId: conversation.id,
      content: body.content,
      files: body.files,
      replyToMessageId: body.replyToMessageId,
    });
  }
}
```

### When to Use REST vs WebSocket?

```
┌──────────────────────────────────────────────────────────────────┐
│                    REST vs WEBSOCKET Usage                        │
├──────────────────────────────────────────────────────────────────┤
│                                                                   │
│  USE REST API (/private-chat) WHEN:                              │
│  ✓ Loading conversation history on page load                     │
│  ✓ Implementing pagination (load more messages)                  │
│  ✓ Fallback when WebSocket connection fails                      │
│  ✓ Server-side operations (background jobs, admin tools)         │
│                                                                   │
│  USE WEBSOCKET (Gateway) WHEN:                                   │
│  ✓ Sending messages in real-time                                 │
│  ✓ Receiving new messages instantly                              │
│  ✓ Typing indicators                                             │
│  ✓ Read receipts                                                 │
│  ✓ Online/offline status                                         │
│                                                                   │
└──────────────────────────────────────────────────────────────────┘
```

---

## 7. DTOs - Data Transfer Objects

### File: `src/main/shared/private-message/privateChatGateway/privateChatGateway.dto.ts`

```typescript
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray } from 'class-validator';

// ═══════════════════════════════════════════════════════════════
// DTO for sending a private message
// ═══════════════════════════════════════════════════════════════
export class SendPrivateMessageDto {
  @ApiProperty({
    description: 'ID of the user to send the message to',
    example: 'clx123abc456def',
  })
  @IsString()
  recipientId: string;

  @ApiPropertyOptional({
    description: 'Text content of the message',
    example: 'Hello, how are you?',
  })
  @IsString()
  @IsOptional()
  content?: string;

  @ApiPropertyOptional({
    description: 'Array of file IDs to attach',
    example: ['file_id_1', 'file_id_2'],
  })
  @IsArray()
  @IsOptional()
  files?: string[];

  @ApiPropertyOptional({
    description: 'ID of message being replied to',
    example: 'msg_xyz789',
  })
  @IsString()
  @IsOptional()
  replyToMessageId?: string;
}
```

---

## 8. Complete Message Flow

### Step-by-Step Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    COMPLETE MESSAGE FLOW                                 │
└─────────────────────────────────────────────────────────────────────────┘

ALICE (Sender)                    SERVER                         BOB (Recipient)
    │                               │                                │
    │                               │                                │
═══ CONNECTION PHASE ═══════════════════════════════════════════════════════
    │                               │                                │
    │  1. io.connect('/pv/message', │                                │
    │     { auth: { token: JWT }})  │                                │
    │──────────────────────────────>│                                │
    │                               │                                │
    │  2. handleConnection()        │                                │
    │     - Verify JWT              │                                │
    │     - Store user data         │                                │
    │     - Join room 'user_alice'  │                                │
    │                               │                                │
    │  3. SUCCESS: "Connected"      │                                │
    │<──────────────────────────────│                                │
    │                               │                                │
    │                               │  4. Bob connects similarly     │
    │                               │<───────────────────────────────│
    │                               │                                │
    │                               │  5. SUCCESS: "Connected"       │
    │                               │───────────────────────────────>│
    │                               │                                │
═══ TYPING PHASE ══════════════════════════════════════════════════════════
    │                               │                                │
    │  6. TYPING {                  │                                │
    │     recipientId: 'bob_id'     │                                │
    │  }                            │                                │
    │──────────────────────────────>│                                │
    │                               │                                │
    │                               │  7. TYPING_STATUS {            │
    │                               │     userId: 'alice_id',        │
    │                               │     isTyping: true             │
    │                               │  }                             │
    │                               │───────────────────────────────>│
    │                               │                                │
    │                               │     Bob sees "Alice is typing" │
    │                               │                                │
═══ MESSAGE PHASE ═════════════════════════════════════════════════════════
    │                               │                                │
    │  8. SEND_MESSAGE {            │                                │
    │     recipientId: 'bob_id',    │                                │
    │     content: 'Hey Bob!'       │                                │
    │  }                            │                                │
    │──────────────────────────────>│                                │
    │                               │                                │
    │  9. handleSendMessage()       │                                │
    │     a) Find/create convo      │                                │
    │     b) Save to database       │                                │
    │     c) Update lastMessage     │                                │
    │                               │                                │
    │                               │  10. NEW_MESSAGE {             │
    │                               │      id: 'msg_123',            │
    │                               │      content: 'Hey Bob!',      │
    │                               │      sender: { name: 'Alice' } │
    │                               │  }                             │
    │                               │───────────────────────────────>│
    │                               │                                │
    │  11. SUCCESS {                │     Bob sees new message! 🔔   │
    │      message: 'Sent',         │                                │
    │      data: { msg_123... }     │                                │
    │  }                            │                                │
    │<──────────────────────────────│                                │
    │                               │                                │
═══ READ RECEIPT PHASE ════════════════════════════════════════════════════
    │                               │                                │
    │                               │  12. Bob reads the message     │
    │                               │                                │
    │                               │  13. MARK_AS_READ {            │
    │                               │      messageId: 'msg_123',     │
    │                               │      senderId: 'alice_id'      │
    │                               │  }                             │
    │                               │<───────────────────────────────│
    │                               │                                │
    │  14. MESSAGE_READ {           │  handleMarkAsRead()            │
    │      messageId: 'msg_123',    │  - Update DB: isRead = true    │
    │      readBy: 'bob_id',        │                                │
    │      readAt: '2026-01-23...'  │                                │
    │  }                            │                                │
    │<──────────────────────────────│                                │
    │                               │                                │
    │  Alice sees ✓✓ (read)         │                                │
    │                               │                                │
```

---

## 9. Frontend Integration Guide

### Complete React Example

```typescript
// ═══════════════════════════════════════════════════════════════
// chat-service.ts - Socket.IO Client Service
// ═══════════════════════════════════════════════════════════════
import { io, Socket } from 'socket.io-client';

// Event types for TypeScript
interface Message {
  id: string;
  content: string;
  senderId: string;
  conversationId: string;
  createdAt: string;
  sender: {
    id: string;
    name: string;
    profileImage?: string;
  };
  files?: Array<{ id: string; url: string }>;
  replyTo?: {
    id: string;
    content: string;
    sender: { name: string };
  };
}

interface TypingStatus {
  userId: string;
  isTyping: boolean;
}

interface MessageReadStatus {
  messageId: string;
  readBy: string;
  readAt: string;
}

class ChatService {
  private socket: Socket | null = null;
  private messageCallbacks: ((message: Message) => void)[] = [];
  private typingCallbacks: ((status: TypingStatus) => void)[] = [];
  private readCallbacks: ((status: MessageReadStatus) => void)[] = [];

  // ═══════════════════════════════════════════════════════════════
  // CONNECT - Establish WebSocket connection
  // ═══════════════════════════════════════════════════════════════
  connect(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = io('http://localhost:3000/pv/message', {
        auth: { token },
        transports: ['websocket', 'polling'],
      });

      this.socket.on('SUCCESS', (data) => {
        console.log('Connected to chat:', data.message);
        resolve();
      });

      this.socket.on('ERROR', (error) => {
        console.error('Connection error:', error.message);
        reject(new Error(error.message));
      });

      // Set up event listeners
      this.setupEventListeners();
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SETUP EVENT LISTENERS - Handle incoming events
  // ═══════════════════════════════════════════════════════════════
  private setupEventListeners(): void {
    if (!this.socket) return;

    // New message received
    this.socket.on('NEW_MESSAGE', (message: Message) => {
      console.log('New message:', message);
      this.messageCallbacks.forEach((cb) => cb(message));
    });

    // Typing status update
    this.socket.on('TYPING_STATUS', (status: TypingStatus) => {
      this.typingCallbacks.forEach((cb) => cb(status));
    });

    // Message read receipt
    this.socket.on('MESSAGE_READ', (status: MessageReadStatus) => {
      this.readCallbacks.forEach((cb) => cb(status));
    });

    // Handle disconnect
    this.socket.on('disconnect', (reason) => {
      console.log('Disconnected:', reason);
    });

    // Handle reconnection
    this.socket.on('connect', () => {
      console.log('Reconnected to chat');
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // SEND MESSAGE - Send a new message
  // ═══════════════════════════════════════════════════════════════
  sendMessage(
    recipientId: string,
    content: string,
    options?: {
      files?: string[];
      replyToMessageId?: string;
    },
  ): void {
    if (!this.socket) {
      throw new Error('Not connected to chat');
    }

    this.socket.emit('SEND_MESSAGE', {
      recipientId,
      content,
      files: options?.files,
      replyToMessageId: options?.replyToMessageId,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // TYPING INDICATORS
  // ═══════════════════════════════════════════════════════════════
  startTyping(recipientId: string): void {
    this.socket?.emit('TYPING', { recipientId });
  }

  stopTyping(recipientId: string): void {
    this.socket?.emit('STOP_TYPING', { recipientId });
  }

  // ═══════════════════════════════════════════════════════════════
  // MARK AS READ
  // ═══════════════════════════════════════════════════════════════
  markAsRead(messageId: string, senderId: string): void {
    this.socket?.emit('MARK_AS_READ', { messageId, senderId });
  }

  // ═══════════════════════════════════════════════════════════════
  // EVENT SUBSCRIPTIONS
  // ═══════════════════════════════════════════════════════════════
  onNewMessage(callback: (message: Message) => void): () => void {
    this.messageCallbacks.push(callback);
    return () => {
      this.messageCallbacks = this.messageCallbacks.filter(
        (cb) => cb !== callback,
      );
    };
  }

  onTypingStatus(callback: (status: TypingStatus) => void): () => void {
    this.typingCallbacks.push(callback);
    return () => {
      this.typingCallbacks = this.typingCallbacks.filter(
        (cb) => cb !== callback,
      );
    };
  }

  onMessageRead(callback: (status: MessageReadStatus) => void): () => void {
    this.readCallbacks.push(callback);
    return () => {
      this.readCallbacks = this.readCallbacks.filter((cb) => cb !== callback);
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // DISCONNECT
  // ═══════════════════════════════════════════════════════════════
  disconnect(): void {
    this.socket?.disconnect();
    this.socket = null;
  }
}

// Export singleton instance
export const chatService = new ChatService();
```

### React Hook Usage

```typescript
// ═══════════════════════════════════════════════════════════════
// useChat.ts - React Hook for Chat
// ═══════════════════════════════════════════════════════════════
import { useState, useEffect, useCallback } from 'react';
import { chatService } from './chat-service';

export function useChat(token: string, recipientId: string) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isTyping, setIsTyping] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  // Connect on mount
  useEffect(() => {
    chatService
      .connect(token)
      .then(() => setIsConnected(true))
      .catch((error) => console.error('Failed to connect:', error));

    return () => chatService.disconnect();
  }, [token]);

  // Listen for new messages
  useEffect(() => {
    const unsubscribe = chatService.onNewMessage((message) => {
      setMessages((prev) => [...prev, message]);
    });

    return unsubscribe;
  }, []);

  // Listen for typing status
  useEffect(() => {
    const unsubscribe = chatService.onTypingStatus((status) => {
      if (status.userId === recipientId) {
        setIsTyping(status.isTyping);
      }
    });

    return unsubscribe;
  }, [recipientId]);

  // Send message function
  const sendMessage = useCallback(
    (content: string) => {
      chatService.sendMessage(recipientId, content);
    },
    [recipientId],
  );

  // Typing functions with debounce
  const handleTyping = useCallback(() => {
    chatService.startTyping(recipientId);
  }, [recipientId]);

  const handleStopTyping = useCallback(() => {
    chatService.stopTyping(recipientId);
  }, [recipientId]);

  return {
    messages,
    isTyping,
    isConnected,
    sendMessage,
    handleTyping,
    handleStopTyping,
  };
}
```

### React Component Example

```tsx
// ═══════════════════════════════════════════════════════════════
// ChatWindow.tsx - Chat UI Component
// ═══════════════════════════════════════════════════════════════
import React, { useState, useRef, useEffect } from 'react';
import { useChat } from './useChat';

interface ChatWindowProps {
  token: string;
  recipientId: string;
  recipientName: string;
}

export function ChatWindow({
  token,
  recipientId,
  recipientName,
}: ChatWindowProps) {
  const [inputValue, setInputValue] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout>();

  const {
    messages,
    isTyping,
    isConnected,
    sendMessage,
    handleTyping,
    handleStopTyping,
  } = useChat(token, recipientId);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Handle input change with typing indicator
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setInputValue(e.target.value);

    // Start typing indicator
    handleTyping();

    // Clear existing timeout
    if (typingTimeoutRef.current) {
      clearTimeout(typingTimeoutRef.current);
    }

    // Stop typing after 2 seconds of inactivity
    typingTimeoutRef.current = setTimeout(() => {
      handleStopTyping();
    }, 2000);
  };

  // Handle send
  const handleSend = () => {
    if (!inputValue.trim()) return;

    sendMessage(inputValue);
    setInputValue('');
    handleStopTyping();
  };

  // Handle enter key
  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="chat-window">
      {/* Header */}
      <div className="chat-header">
        <h3>{recipientName}</h3>
        <span className={`status ${isConnected ? 'online' : 'offline'}`}>
          {isConnected ? '🟢 Connected' : '🔴 Disconnected'}
        </span>
      </div>

      {/* Messages */}
      <div className="messages-container">
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message ${
              message.senderId === recipientId ? 'received' : 'sent'
            }`}
          >
            <div className="message-content">{message.content}</div>
            <div className="message-time">
              {new Date(message.createdAt).toLocaleTimeString()}
            </div>
          </div>
        ))}

        {/* Typing indicator */}
        {isTyping && (
          <div className="typing-indicator">{recipientName} is typing...</div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="input-container">
        <input
          type="text"
          value={inputValue}
          onChange={handleInputChange}
          onKeyPress={handleKeyPress}
          placeholder="Type a message..."
          disabled={!isConnected}
        />
        <button
          onClick={handleSend}
          disabled={!isConnected || !inputValue.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}
```

---

## 10. Key Concepts Explained

### Socket.IO Key Concepts

| Concept       | Explanation                                    | Example                         |
| ------------- | ---------------------------------------------- | ------------------------------- |
| **Namespace** | Separate communication channels on same server | `/pv/message`, `/notifications` |
| **Room**      | Group sockets together to broadcast to subset  | `user_123`, `chat_room_456`     |
| **Emit**      | Send event to client(s)                        | `socket.emit('EVENT', data)`    |
| **On**        | Listen for events                              | `socket.on('EVENT', handler)`   |
| **Broadcast** | Send to all except sender                      | `socket.broadcast.emit()`       |
| **To**        | Send to specific room                          | `server.to('room').emit()`      |

### NestJS Gateway Decorators

| Decorator             | Purpose                          |
| --------------------- | -------------------------------- |
| `@WebSocketGateway()` | Mark class as WebSocket gateway  |
| `@WebSocketServer()`  | Inject Socket.IO server instance |
| `@SubscribeMessage()` | Handle specific event            |
| `@ConnectedSocket()`  | Get client socket in handler     |
| `@MessageBody()`      | Get event payload                |

### Authentication Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    JWT AUTHENTICATION                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. User logs in via REST API                                   │
│     POST /auth/login { email, password }                        │
│                                                                  │
│  2. Server returns JWT token                                     │
│     { accessToken: "eyJhbGc..." }                               │
│                                                                  │
│  3. Client connects to WebSocket with token                      │
│     io('/pv/message', { auth: { token: 'eyJhbGc...' } })       │
│                                                                  │
│  4. Gateway verifies token in handleConnection()                 │
│     - If valid: Allow connection, join room                      │
│     - If invalid: Disconnect client                              │
│                                                                  │
│  5. All subsequent events have user info in client.data.user    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Error Handling Pattern

```typescript
@SubscribeMessage('SOME_EVENT')
async handleEvent(@ConnectedSocket() client: Socket, @MessageBody() data: any) {
  try {
    // Your logic here
    const result = await this.service.doSomething(data);

    // Success response
    client.emit('SUCCESS', {
      message: 'Operation successful',
      data: result,
    });
  } catch (error) {
    // Error response
    client.emit('ERROR', {
      message: error.message || 'Something went wrong',
      code: error.code,
    });

    // Optionally log the error
    console.error('Event handler error:', error);
  }
}
```

---

## Summary

The private messaging system in this project follows a clean architecture:

1. **Gateway** handles real-time WebSocket connections and events
2. **Service** contains all business logic and database operations
3. **Controller** provides REST API fallback
4. **Prisma** manages database models and queries

Key features implemented:

- ✅ One-to-one private messaging
- ✅ Real-time message delivery
- ✅ Typing indicators
- ✅ Read receipts
- ✅ File attachments
- ✅ Message replies
- ✅ JWT authentication
- ✅ Conversation management

---

_This guide is part of the yousef-server project documentation._
_Generated on January 23, 2026_

---

_Generated from GitHub Copilot Chat Session - January 23, 2026_

// src/common/interface/notification-payload.ts
import { NotificationType, Prisma } from '@prisma/client';

export interface NotificationPayload {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  meta: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

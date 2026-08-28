import type { Button, QuickReply } from "../api/client";

export interface SendContext {
  idempotencyKey: string;
  conversationId?: string;
  contactId?: string;
}

export interface SendResult {
  externalMessageId?: string;
  recipientId?: string;
}

export interface MessagingChannel {
  sendText(recipientId: string, text: string, context: SendContext): Promise<SendResult>;
  sendImage(recipientId: string, imageUrl: string, context: SendContext): Promise<SendResult>;
  sendButtons(recipientId: string, text: string, buttons: Button[], context: SendContext): Promise<SendResult>;
  sendQuickReplies(recipientId: string, text: string, replies: QuickReply[], context: SendContext): Promise<SendResult>;
  sendPrivateCommentReply(commentId: string, text: string, buttons: Button[] | undefined, context: SendContext): Promise<SendResult>;
  replyToComment(commentId: string, text: string, context: SendContext): Promise<SendResult>;
}

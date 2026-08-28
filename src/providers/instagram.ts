import type { InstagramClient } from "../api/client";
import { InstagramApiError } from "../api/client";
import { claimSend, releaseSend } from "../db";
import type { Button, QuickReply } from "../api/client";
import type { MessagingChannel, SendContext, SendResult } from "./messaging";

export class InstagramChannel implements MessagingChannel {
  constructor(
    private readonly db: D1Database,
    private readonly client: InstagramClient,
  ) {}

  private async once(
    context: SendContext,
    operation: () => Promise<{ message_id?: string; recipient_id?: string; id?: string }>,
  ): Promise<SendResult> {
    if (!(await claimSend(this.db, context.idempotencyKey))) return {};
    try {
      const result = await operation();
      return { externalMessageId: result.message_id ?? result.id, recipientId: result.recipient_id };
    } catch (error) {
      if (error instanceof InstagramApiError) await releaseSend(this.db, context.idempotencyKey);
      throw error;
    }
  }

  sendText(recipientId: string, text: string, context: SendContext): Promise<SendResult> {
    return this.once(context, () => this.client.sendText(recipientId, text));
  }

  sendImage(recipientId: string, imageUrl: string, context: SendContext): Promise<SendResult> {
    return this.once(context, () => this.client.sendImage(recipientId, imageUrl));
  }

  sendButtons(recipientId: string, text: string, buttons: Button[], context: SendContext): Promise<SendResult> {
    return this.once(context, () => this.client.sendButtonTemplate({ igsid: recipientId }, text, buttons));
  }

  sendQuickReplies(recipientId: string, text: string, replies: QuickReply[], context: SendContext): Promise<SendResult> {
    return this.once(context, () => this.client.sendQuickReplies(recipientId, text, replies));
  }

  sendPrivateCommentReply(commentId: string, text: string, buttons: Button[] | undefined, context: SendContext): Promise<SendResult> {
    return this.once(context, () => buttons?.length
      ? this.client.privateReplyWithButtons(commentId, text, buttons)
      : this.client.privateReply(commentId, text));
  }

  replyToComment(commentId: string, text: string, context: SendContext): Promise<SendResult> {
    return this.once(context, () => this.client.replyToComment(commentId, text));
  }
}

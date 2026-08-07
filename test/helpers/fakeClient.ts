// A fake InstagramClient that records calls and can be told to fail the next N calls of a method
// (to exercise send-failure retry paths). Cast to InstagramClient when constructing the Engine.

import { InstagramApiError } from "../../src/api/client";
import type { InstagramClient } from "../../src/api/client";

type Method = "privateReply" | "reply" | "like" | "quick" | "text" | "followers";

export class FakeClient {
  calls: Record<Method, unknown[]> = {
    privateReply: [],
    reply: [],
    like: [],
    quick: [],
    text: [],
    followers: [],
  };
  /** How many upcoming calls of each method should throw a (non-rate-limit) error. */
  failNext: Partial<Record<Method, number>> = {};
  followers = 100;

  private guard(m: Method): void {
    const n = this.failNext[m] ?? 0;
    if (n > 0) {
      this.failNext[m] = n - 1;
      throw new InstagramApiError("simulated failure", 500);
    }
  }

  async privateReplyWithButtons(commentId: string, text: string, buttons: unknown) {
    this.guard("privateReply");
    this.calls.privateReply.push({ commentId, text, buttons });
    return { message_id: "m" };
  }
  async replyToComment(commentId: string, message: string) {
    this.guard("reply");
    this.calls.reply.push({ commentId, message });
    return { id: "r" };
  }
  async likeComment(commentId: string) {
    this.guard("like");
    this.calls.like.push({ commentId });
    return { success: true };
  }
  async sendQuickReplies(igsid: string, text: string, quickReplies: unknown) {
    this.guard("quick");
    this.calls.quick.push({ igsid, text, quickReplies });
    return { message_id: "m" };
  }
  async sendText(igsid: string, text: string) {
    this.guard("text");
    this.calls.text.push({ igsid, text });
    return { message_id: "m" };
  }
  async getFollowersCount() {
    this.calls.followers.push({});
    return this.followers;
  }

  asClient(): InstagramClient {
    return this as unknown as InstagramClient;
  }
}

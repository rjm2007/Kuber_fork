"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { formatChatTime } from "@/lib/chat-format";
import { COMMENT_REACTION_EMOJIS } from "@/lib/comment-reactions";
import type { CommentReactionGroup, LeadComment } from "@/lib/api-client";
import { Avatar } from "@/components/leads/lead-ui";

type DiscussionCommentProps = {
  comment: LeadComment;
  isOwn: boolean;
  currentUserId: string;
  compact?: boolean;
  onToggleReaction: (emoji: string) => Promise<void>;
};

export function DiscussionComment({
  comment,
  isOwn,
  currentUserId,
  compact = false,
  onToggleReaction,
}: DiscussionCommentProps) {
  const [pendingEmoji, setPendingEmoji] = useState<string | null>(null);
  const [reactions, setReactions] = useState<CommentReactionGroup[]>(comment.reactions ?? []);

  useEffect(() => {
    setReactions(comment.reactions ?? []);
  }, [comment.reactions]);

  async function handleToggle(emoji: string) {
    if (pendingEmoji) return;
    const previous = reactions;
    const existing = reactions.find((reaction) => reaction.emoji === emoji);

    setReactions((current) => {
      if (existing?.reacted_by_me) {
        return current.flatMap((reaction) => {
          if (reaction.emoji !== emoji) return [reaction];
          const users = reaction.users.filter((user) => user.id !== currentUserId);
          return reaction.count <= 1
            ? []
            : [{ ...reaction, count: reaction.count - 1, reacted_by_me: false, users }];
        });
      }

      if (existing) {
        return current.map((reaction) =>
          reaction.emoji === emoji
            ? {
                ...reaction,
                count: reaction.count + 1,
                reacted_by_me: true,
                users: [...reaction.users, { id: currentUserId, name: "You" }],
              }
            : reaction,
        );
      }

      return [
        ...current,
        {
          emoji,
          count: 1,
          reacted_by_me: true,
          users: [{ id: currentUserId, name: "You" }],
        },
      ];
    });
    setPendingEmoji(emoji);
    try {
      await onToggleReaction(emoji);
    } catch {
      setReactions(previous);
    } finally {
      setPendingEmoji(null);
    }
  }

  return (
    <div
      className={cn(
        "group relative w-full cursor-pointer border border-border bg-field dark:bg-secondary transition-colors",
        compact ? "rounded-lg px-3 py-2.5" : "rounded-xl px-4 py-3",
      )}
    >
        {/* Hover reaction picker */}
        <div
          className={cn(
            "absolute -top-3 right-3 z-10 flex items-center gap-0.5 rounded-full border border-border bg-field px-1 py-0.5 shadow-md",
            "opacity-0 pointer-events-none transition-opacity",
            "group-hover:opacity-100 group-hover:pointer-events-auto focus-within:opacity-100 focus-within:pointer-events-auto",
          )}
        >
          {COMMENT_REACTION_EMOJIS.map((emoji) => {
            const active = reactions.some((r) => r.emoji === emoji && r.reacted_by_me);
            return (
              <button
                key={emoji}
                type="button"
                disabled={pendingEmoji !== null}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleToggle(emoji);
                }}
                className={cn(
                  "cursor-pointer rounded-full px-1.5 py-0.5 text-sm leading-none transition-colors hover:bg-secondary",
                  active && "bg-primary/10 ring-1 ring-primary/30",
                  pendingEmoji === emoji && "opacity-50",
                )}
                aria-label={active ? `Remove ${emoji} reaction` : `React with ${emoji}`}
                title={active ? `Remove ${emoji}` : `React with ${emoji}`}
              >
                {emoji}
              </button>
            );
          })}
        </div>

        <div className={cn("mb-1.5 flex items-center gap-2.5", compact && "mb-1 gap-2")}>
          <Avatar name={comment.author_name} size="sm" />
          <span className={cn("font-semibold truncate", compact ? "text-[11px]" : "text-xs")}>
            {isOwn ? "You" : comment.author_name}
          </span>
          <span
            className={cn(
              "text-muted-foreground whitespace-nowrap",
              compact ? "text-[9px]" : "text-[10px]",
            )}
          >
            {formatChatTime(comment.created_at)}
          </span>
        </div>

        <p
          className={cn(
            "leading-relaxed text-foreground whitespace-pre-wrap wrap-break-word",
            compact ? "text-xs" : "text-sm",
          )}
        >
          {comment.body}
        </p>

        {reactions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {reactions.map((group) => (
              <div key={group.emoji} className="group/reaction relative">
                <button
                  type="button"
                  disabled={pendingEmoji !== null}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleToggle(group.emoji);
                  }}
                  className={cn(
                    "inline-flex cursor-pointer items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none transition-colors",
                    group.reacted_by_me
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border bg-background/60 text-muted-foreground hover:bg-secondary",
                  )}
                  aria-label={`${group.emoji} ${group.count} — ${group.users.map((u) => u.name).join(", ")}`}
                >
                  <span className="text-sm leading-none">{group.emoji}</span>
                  <span className="font-medium tabular-nums translate-y-px">{group.count}</span>
                </button>

                {/* Hover popup — who reacted with this emoji */}
                <div
                  className={cn(
                    "absolute bottom-full left-0 z-20 mb-1.5 w-max max-w-52 rounded-lg border border-border bg-popover px-2.5 py-2 shadow-lg",
                    "opacity-0 pointer-events-none transition-opacity duration-100",
                    "group-hover/reaction:opacity-100",
                  )}
                  role="tooltip"
                >
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] font-medium text-muted-foreground">
                    <span className="text-xs leading-none">{group.emoji}</span>
                    {group.count} {group.count === 1 ? "person" : "people"}
                  </div>
                  <ul className="space-y-1">
                    {group.users.map((user) => (
                      <li key={user.id} className="flex items-center gap-1.5">
                        <Avatar name={user.name} size="sm" />
                        <span className="text-[11px] font-medium text-popover-foreground truncate">
                          {user.id === currentUserId ? "You" : user.name}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        )}
    </div>
  );
}

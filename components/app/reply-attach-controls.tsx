"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Paperclip, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { uploadCampaignAttachment } from "@/lib/api-client";
import {
  formatAttachmentBytes,
  REPLY_ATTACH_ACCEPT,
  REPLY_ATTACH_MAX_BYTES,
  REPLY_ATTACH_MAX_FILES,
  type ReplyAttachment,
} from "@/lib/reply-attachments";

export function ReplyAttachButton({
  token,
  disabled,
  currentCount,
  onUploaded,
}: {
  token: string;
  disabled?: boolean;
  currentCount: number;
  onUploaded: (attachment: ReplyAttachment) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [attaching, setAttaching] = useState(false);

  async function handleFiles(list: FileList | null) {
    const files = Array.from(list ?? []);
    if (files.length === 0) return;
    const room = REPLY_ATTACH_MAX_FILES - currentCount;
    if (room <= 0) {
      toast.error(`You can attach up to ${REPLY_ATTACH_MAX_FILES} files`);
      return;
    }
    const picked = files.slice(0, room);
    if (files.length > room) {
      toast.error(`Only ${room} more file${room === 1 ? "" : "s"} can be attached`);
    }

    setAttaching(true);
    try {
      for (const file of picked) {
        if (file.size > REPLY_ATTACH_MAX_BYTES) {
          toast.error(`${file.name} exceeds 10MB`);
          continue;
        }
        const up = await uploadCampaignAttachment(token, file);
        if (!up.attachment_url) {
          toast.error(`${file.name}: upload succeeded but no link was returned`);
          continue;
        }
        onUploaded({
          name: up.attachment_name,
          mime: up.attachment_mime,
          size: up.attachment_size,
          url: up.attachment_url,
        });
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAttaching(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        accept={REPLY_ATTACH_ACCEPT}
        multiple
        onChange={(e) => void handleFiles(e.target.files)}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled || attaching || currentCount >= REPLY_ATTACH_MAX_FILES}
        onClick={() => inputRef.current?.click()}
        className="gap-1.5"
        title="Attach a file or image. Instantly cannot send real attachments — images are shown in the email, other files as a download link."
      >
        {attaching ? <Loader2 className="size-3.5 animate-spin" /> : <Paperclip className="size-3.5" />}
        {attaching ? "Uploading…" : "Attach"}
      </Button>
    </>
  );
}

export function ReplyAttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: ReplyAttachment[];
  onRemove: (index: number) => void;
}) {
  if (attachments.length === 0) return null;

  return (
    <ul className="flex flex-col gap-1.5">
      {attachments.map((a, i) => (
        <li
          key={`${a.url}-${i}`}
          className="flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5 min-w-0"
        >
          {a.mime.startsWith("image/") ? (
            // Hosted download URL — not a Next image domain, and this is a compose chip not a page asset.
            // eslint-disable-next-line @next/next/no-img-element
            <img src={a.url} alt="" className="size-8 rounded object-cover shrink-0 bg-secondary" />
          ) : (
            <FileText className="size-4 text-muted-foreground shrink-0" />
          )}
          <span className="text-xs truncate min-w-0">{a.name}</span>
          <span className="font-mono text-[10px] text-muted-foreground shrink-0 tabular-nums">
            {formatAttachmentBytes(a.size)}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => onRemove(i)}
            aria-label={`Remove ${a.name}`}
          >
            <X className="size-3.5" />
          </Button>
        </li>
      ))}
    </ul>
  );
}

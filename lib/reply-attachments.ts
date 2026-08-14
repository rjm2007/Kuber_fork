import { escapeHtml } from "@/lib/reply-body-html";

export type ReplyAttachment = {
  name: string;
  mime: string;
  size: number;
  url: string;
};

export const REPLY_ATTACH_ACCEPT = ".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg";
export const REPLY_ATTACH_MAX_BYTES = 10 * 1024 * 1024;
export const REPLY_ATTACH_MAX_FILES = 5;

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

export function formatAttachmentBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** HTML Instantly actually delivers — images inline, other files as a download link.
 *  Instantly's reply API has no attachment field, so this is the only way a file
 *  can reach the lead. */
export function replyAttachmentHtml(a: ReplyAttachment, opts?: { inlineImages?: boolean }): string {
  const url = escapeAttr(a.url);
  const name = escapeHtml(a.name);
  if (opts?.inlineImages !== false && a.mime.startsWith("image/")) {
    return `<p><img src="${url}" alt="${name}" style="max-width:100%;height:auto;border-radius:8px;" /><br><a href="${url}" target="_blank" rel="noopener">${name}</a></p>`;
  }
  return `<p>📎 <a href="${url}" target="_blank" rel="noopener">${name}</a></p>`;
}

export function appendReplyAttachments(
  bodyHtml: string,
  attachments: ReplyAttachment[],
  opts?: { inlineImages?: boolean },
): string {
  if (attachments.length === 0) return bodyHtml;
  return `${bodyHtml}${attachments.map((a) => replyAttachmentHtml(a, opts)).join("")}`;
}

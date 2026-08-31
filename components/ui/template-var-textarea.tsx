"use client";

import { useRef } from "react";
import { Copy } from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import type { TemplateVar } from "@/components/ui/rich-text-editor";

export type { TemplateVar };

// Tokens actually substituted by fillFollowupTemplate (lib/services/
// followup-template.ts) for a follow-up's fallback body, and by the
// equivalent fill in lib/services/generate-drafts.ts for the Settings
// "Default draft" body. Both read the same three placeholders, so both UIs
// should offer the same three pills — one source of truth instead of two
// arrays that can silently drift apart.
export const LEAD_TEMPLATE_VARS: TemplateVar[] = [
  { token: "first_name", label: "first_name", description: "Lead's first name", example: "John" },
  { token: "last_name", label: "last_name", description: "Lead's last name", example: "Doe" },
  { token: "company", label: "company", description: "Lead's company", example: "Acme Inc." },
];

interface TemplateVarTextareaProps {
  value: string;
  onChange: (value: string) => void;
  /** Pills for inserting {{token}} at the cursor. Pass the exact tokens the
   *  reading code substitutes (see TemplateVar's doc comment in
   *  rich-text-editor.tsx) — same contract as RichTextEditor's templateVars,
   *  just for a plain-text field instead of an HTML body. */
  templateVars: TemplateVar[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

/**
 * A plain Textarea with clickable {{token}} pills above it.
 *
 * Not RichTextEditor: that component's value is HTML, and several places that
 * read a follow-up instruction or fallback string treat it as plain text
 * fed straight to an LLM prompt or wrapped in plainToHtml — storing real HTML
 * there means visible "<p>" tags in a sent email, or literal markup in a
 * prompt. This gives the same pill-insertion UX without that risk.
 */
export function TemplateVarTextarea({
  value,
  onChange,
  templateVars,
  placeholder,
  disabled,
  className,
}: TemplateVarTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  function insert(token: string) {
    const text = `{{${token}}}`;
    const el = ref.current;
    if (!el) {
      onChange(`${value}${text}`);
      return;
    }
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? value.length;
    const next = value.slice(0, start) + text + value.slice(end);
    onChange(next);
    // Restore focus and caret after the inserted token — onChange above just
    // re-rendered the textarea's value out from under the current selection.
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  }

  return (
    <div className="space-y-1.5">
      {templateVars.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          {templateVars.map((v) => (
            <div key={v.token} className="relative group">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => insert(v.token)}
                className="h-6 gap-1 rounded px-1.5 py-0.5 bg-primary/15 text-primary text-[11px] font-mono font-semibold border border-primary/25 hover:bg-primary/25 hover:text-primary"
              >
                {v.label}
                <Copy className="size-2.5 opacity-60" />
              </Button>
              <div className="pointer-events-none absolute top-full left-0 mt-1.5 z-50 w-48 rounded-md bg-popover border border-border shadow-lg px-3 py-2 opacity-0 group-hover:opacity-100 transition-opacity">
                <p className="text-xs font-semibold text-foreground">{v.description}</p>
                {v.example && <p className="text-[11px] text-muted-foreground mt-0.5">e.g. &quot;{v.example}&quot;</p>}
                <p className="text-[11px] text-muted-foreground mt-1">
                  Type <span className="font-mono bg-muted px-0.5 rounded">{`{{${v.token}}}`}</span> or click to insert
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
      <Textarea
        ref={ref}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={className}
      />
    </div>
  );
}

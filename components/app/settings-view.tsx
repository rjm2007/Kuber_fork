"use client";

import type React from "react";
import { toast } from "sonner";
import { useEffect, useRef, useState } from "react";
import {
  User, Bot, LogOut, Plus,
  ChevronRight, PenLine, Bold, Italic, Underline,
  List, ListOrdered, Link2, Undo2, Redo2, Eraser, Type, Palette, Check, Sun, Moon,
  Building2, Package, FileText, X, KeyRound, Gauge, Lock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { AvailabilityToggle } from "@/components/ui/availability-toggle";
import { LEAD_TEMPLATE_VARS } from "@/components/ui/template-var-textarea";
import { InfoTooltip } from "@/components/ui/info-tooltip";
// Aliased: this file also declares its own local RichTextEditor further down
// (a plain-text-output contentEditable wrapper, correct for prompt fields fed
// to an LLM). followup_fallback_body is genuinely HTML — campaign-fanout.ts's
// renderFollowupFallback assigns it straight to an Instantly custom variable
// with no newline-to-<br> conversion — so it needs the real, HTML-output
// shared editor instead, or a manager's line breaks silently vanish in the
// sent email.
import { RichTextEditor as HtmlRichTextEditor, type TemplateVar } from "@/components/ui/rich-text-editor";
import { fetchLogo, fetchSettings, patchSettings, fetchMySettings, patchMySettings, removeLogo, uploadLogo, fetchMyAvailability, setMyAvailability, type AvailabilityStatus } from "@/lib/api-client";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { BRAND_LOGO_CHANGED, COLORS } from "@/lib/branding";
import { MANDATORY_FORMATTING_RULES } from "@/lib/constants";
import { useTheme } from "@/lib/theme-context";
import { useApp } from "@/lib/app-context";
import dynamic from "next/dynamic";

const TeamView = dynamic(
  () => import("@/components/app/team-view").then((m) => m.TeamView),
  { ssr: false, loading: () => <div className="p-8 animate-pulse"><div className="h-40 rounded-xl bg-secondary" /></div> },
);

const KeysView = dynamic(
  () => import("@/components/app/keys-view").then((m) => m.KeysView),
  { ssr: false, loading: () => <div className="p-8 animate-pulse"><div className="h-40 rounded-xl bg-secondary" /></div> },
);

const KeysUsageView = dynamic(
  () => import("@/components/app/keys-usage-view").then((m) => m.KeysUsageView),
  { ssr: false, loading: () => <div className="p-8 animate-pulse"><div className="h-40 rounded-xl bg-secondary" /></div> },
);

const EmailSendingView = dynamic(
  () => import("@/components/app/email-sending-view").then((m) => m.EmailSendingView),
  { ssr: false, loading: () => <div className="p-8 animate-pulse"><div className="h-40 rounded-xl bg-secondary" /></div> },
);

type Section = "profile" | "ai" | "knowledge" | "appearance" | "account" | "team" | "email" | "keys";
type AiSection = "my-writing" | "my-signature" | "template" | "default" | "followup" | "replies" | "footer";
type KnowledgeSection = "company" | "products";
type KeysSection = "credentials" | "usage";
type ProductOffering = { name: string; description: string };

// Only first_name — lib/services/settings.ts's renderFollowupFallback (the
// function that actually fills this field at send time) supports nothing
// else. LEAD_TEMPLATE_VARS' extra company/last_name pills would look right
// here but ship as literal "{{...}}" text.
const FOLLOWUP_FALLBACK_TEMPLATE_VARS: TemplateVar[] = [
  { token: "first_name", label: "first_name", description: "Lead's first name", example: "John" },
];

// Knowledge Sources is open to everyone — employees work with the company
// context and product library more than managers do. Prompt-shaped company
// defaults (Email Template, Reply AI, Footer) remain manager-only.
const NAV_ITEMS: { id: Section; label: string }[] = [
  { id: "profile",    label: "My Profile" },
  { id: "ai",         label: "AI & Outreach" },
  { id: "knowledge",  label: "Knowledge Sources" },
  { id: "appearance", label: "Appearance" },
  { id: "account",    label: "Account" },
];

const MANAGER_NAV_ITEMS: { id: Section; label: string }[] = [
  { id: "profile",    label: "My Profile" },
  { id: "ai",         label: "AI & Outreach" },
  { id: "knowledge",  label: "Knowledge Sources" },
  { id: "appearance", label: "Appearance" },
  { id: "account",    label: "Account" },
  { id: "team",       label: "Team" },
];

// Personal tabs (everyone — stored per user, campaigns you create use these) vs
// company-default tabs (managers only — the fallback every user inherits).
const PERSONAL_AI_NAV_ITEMS: { id: AiSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "my-writing",   label: "My Writing",   icon: PenLine },
  { id: "my-signature", label: "My Signature", icon: Type },
];

const COMPANY_AI_NAV_ITEMS: { id: AiSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "template", label: "Email Template",  icon: PenLine },
  { id: "default",  label: "Default draft",   icon: FileText },
  { id: "followup", label: "Follow-up fallback", icon: FileText },
  { id: "replies",  label: "Reply AI",        icon: Bot },
  { id: "footer",   label: "Email Footer",    icon: Type },
];

const KEYS_NAV_ITEMS: { id: KeysSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "credentials", label: "Credentials", icon: KeyRound },
  { id: "usage",       label: "Usage",       icon: Gauge },
];

const KNOWLEDGE_NAV_ITEMS: { id: KnowledgeSection; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: "company",   label: "Company Details",   icon: Building2 },
  { id: "products",  label: "Product Offerings", icon: Package },
];

type EditorCommand = "bold" | "italic" | "underline" | "insertUnorderedList" | "insertOrderedList" | "undo" | "redo" | "removeFormat";

function textToHtml(value: string) {
  const escaped = value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((p) => p.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br />"))
    .map((p) => `<p>${p || "<br />"}</p>`)
    .join("");
}

function htmlToText(html: string): string {
  return html
    .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, "**$1**")
    .replace(/<b[^>]*>([\s\S]*?)<\/b>/gi, "**$1**")
    .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, "_$1_")
    .replace(/<i[^>]*>([\s\S]*?)<\/i>/gi, "_$1_")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<p[^>]*>/gi, "").replace(/<\/p>/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n").trim();
}

function RichTextEditor({
  label, value, onChange, placeholder, minHeight = 240, helper, singleLineBreaks = false,
}: {
  label: string; value: string; onChange: (v: string) => void;
  placeholder?: string; minHeight?: number; helper?: string;
  /** Enter inserts a line break instead of a paragraph. For sign-off blocks. */
  singleLineBreaks?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastSyncedValue = useRef<string | null>(null);

  useEffect(() => {
    if (!editorRef.current) return;
    const current = htmlToText(editorRef.current.innerHTML);
    if (lastSyncedValue.current === value && current === value) return;
    editorRef.current.innerHTML = textToHtml(value);
    lastSyncedValue.current = value;
  }, [value]);

  function syncValue() {
    const next = htmlToText(editorRef.current?.innerHTML ?? "").replace(/\n{3,}/g, "\n\n").trimEnd();
    lastSyncedValue.current = next;
    onChange(next);
  }

  function runCommand(cmd: EditorCommand) { editorRef.current?.focus(); document.execCommand(cmd); syncValue(); }

  // contentEditable's Enter starts a new paragraph, which htmlToText writes out
  // as a blank line between every entry. Correct for a prompt, wrong for a
  // sign-off block, where the name, title and contact lines belong on
  // consecutive lines. Users were left choosing between a blank line (Enter)
  // and no break at all (backspace, which merges the paragraphs and runs the
  // lines together); the single break needed Shift+Enter, which nobody guesses.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (!singleLineBreaks || e.key !== "Enter" || e.shiftKey) return;
    e.preventDefault();
    document.execCommand("insertLineBreak");
    syncValue();
  }

  function addLink() {
    editorRef.current?.focus();
    const url = window.prompt("Paste a URL");
    if (url) { document.execCommand("createLink", false, url); syncValue(); }
  }

  const toolbar = [
    { label: "Bold",           icon: Bold,         command: "bold" as const },
    { label: "Italic",         icon: Italic,        command: "italic" as const },
    { label: "Underline",      icon: Underline,     command: "underline" as const },
    { label: "Bulleted list",  icon: List,          command: "insertUnorderedList" as const },
    { label: "Numbered list",  icon: ListOrdered,   command: "insertOrderedList" as const },
    { label: "Undo",           icon: Undo2,         command: "undo" as const },
    { label: "Redo",           icon: Redo2,         command: "redo" as const },
    { label: "Clear formatting", icon: Eraser,      command: "removeFormat" as const },
  ];

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex flex-wrap items-center gap-1 border-b border-border bg-secondary/30 px-2 py-1">
          <span className="eyebrow inline-flex h-7 items-center gap-1.5 px-1">
            <Type className="size-3" /> Compose
          </span>
          <div className="mx-1 h-4 w-px bg-border" />
          {toolbar.map(({ label: lbl, icon: Icon, command }) => (
            <Button key={command} type="button" variant="ghost" size="icon-sm" aria-label={lbl} title={lbl}
              onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand(command)}
              className="text-muted-foreground hover:text-foreground">
              <Icon className="size-3.5" />
            </Button>
          ))}
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Add link" title="Add link"
            onMouseDown={(e) => e.preventDefault()} onClick={addLink}
            className="text-muted-foreground hover:text-foreground">
            <Link2 className="size-3.5" />
          </Button>
        </div>
        <div ref={editorRef} role="textbox" aria-label={label} aria-multiline="true"
          contentEditable suppressContentEditableWarning data-placeholder={placeholder}
          onInput={syncValue} onBlur={syncValue} onKeyDown={handleKeyDown}
          className="rich-editor min-w-0 bg-card px-4 py-3 text-sm leading-6 text-foreground outline-none"
          style={{ minHeight }} />
      </div>
      {helper && <p className="text-xs text-muted-foreground">{helper}</p>}
    </div>
  );
}

// A single settings field laid out as label+description on the left and the
// actual control on the right, instead of label-above-control stacked in one
// column. Used throughout Profile / Knowledge Sources / Appearance / Account
// for compact fields; large canvases (rich-text prompts, textareas) stay
// full-width below their own header since cramming them into a narrow right
// column would hurt usability.
function SettingsRow({
  label, description, children, htmlFor,
}: {
  label: string; description?: React.ReactNode; children: React.ReactNode; htmlFor?: string;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 py-5 border-b border-border last:border-0 sm:grid-cols-3 sm:gap-6">
      <div className="sm:col-span-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium text-foreground">{label}</Label>
        {description && <p className="text-xs text-muted-foreground mt-1">{description}</p>}
      </div>
      <div className="sm:col-span-2 min-w-0">{children}</div>
    </div>
  );
}

// A personal drafting/reply prompt fully REPLACES the company default, so it
// looks like it controls everything the AI writes. It doesn't — a small set of
// formatting rules (bold key facts, use bullet pointers) is always appended in
// code after whichever prompt is in effect, so it survives no matter what
// someone writes above. Surfaced here so that isn't a surprise, and someone
// writing their own prompt knows not to duplicate it.
function MandatoryFormattingNotice() {
  const bullets = MANDATORY_FORMATTING_RULES
    .split("\n")
    .filter((line) => line.trim().startsWith("- "))
    .map((line) => line.trim().slice(2));
  return (
    <div className="rounded-md border border-primary/20 bg-primary/5 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <Lock className="size-3.5 text-primary" />
        Always applied on top of the prompt above
      </div>
      <ul className="space-y-1 pl-1 text-xs text-muted-foreground">
        {bullets.map((bullet, i) => (
          <li key={i} className="flex gap-1.5">
            <span className="text-primary/70">•</span>
            <span>{bullet}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Self-service availability toggle (spec §2B) — an employee marking themselves
// available/away (e.g. going on leave) so they stop receiving new automatic
// assignments, without being deactivated. Self-contained (own fetch/save).
function AvailabilityCard() {
  const [status, setStatus] = useState<AvailabilityStatus | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token ?? "";
        const res = await fetchMyAvailability(token);
        setStatus(res.availability_status);
      } catch { /* leave null */ }
    })();
  }, []);

  async function toggle() {
    if (saving || !status) return;
    const next: AvailabilityStatus = status === "online" ? "offline" : "online";
    setSaving(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const res = await setMyAvailability(token, next);
      setStatus(res.availability_status);
      toast.success(res.availability_status === "offline" ? "You're now marked as away" : "You're now available");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border-t border-border pt-6 flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="eyebrow">Assignment</p>
        <p className="text-sm font-medium flex items-center gap-2 mt-1">
          Availability
          {status && (
            <span
              className={cn(
                "size-1.5 rounded-full shrink-0",
                status === "online" ? "bg-emerald-500" : "bg-amber-500",
              )}
              aria-hidden
            />
          )}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {status === "offline"
            ? "You're marked away — you won't receive new automatic lead assignments (you can still be assigned manually)."
            : "You're available for new automatic lead assignments."}
        </p>
      </div>
      <AvailabilityToggle
        status={status}
        disabled={saving}
        onToggle={() => void toggle()}
      />
    </div>
  );
}

export function SettingsView() {
  const { theme, mode, setTheme, setMode, savingTheme } = useTheme();
  const { role } = useApp();
  const isManager = role === "manager";
  // Declared here (rather than alongside the other useState calls below) so
  // navItems — which needs it — can be computed in the same statement order
  // hooks already run in; moving a useState call is safe as long as it still
  // runs unconditionally on every render.
  const [isSuperAdmin, setIsSuperAdmin] = useState(false);
  const navItems = isManager
    ? [...MANAGER_NAV_ITEMS, { id: "email" as const, label: "Email & Sending" }, { id: "keys" as const, label: "Keys" }]
    : NAV_ITEMS;
  const aiNavItems = isManager ? [...PERSONAL_AI_NAV_ITEMS, ...COMPANY_AI_NAV_ITEMS] : PERSONAL_AI_NAV_ITEMS;
  // Company Details is company identity (sender name, context, logo) — manager /
  // super-admin only. Employees keep the Product Offerings library.
  const knowledgeNavItems = isManager ? KNOWLEDGE_NAV_ITEMS : KNOWLEDGE_NAV_ITEMS.filter((i) => i.id !== "company");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [section, setSection] = useState<Section>("profile");
  const [aiSection, setAiSection] = useState<AiSection>("my-writing");
  const [knowledgeSection, setKnowledgeSection] = useState<KnowledgeSection>("company");
  const [keysSection, setKeysSection] = useState<KeysSection>("credentials");

  // Company-wide settings (managers edit; everyone inherits)
  const [senderName,     setSenderName    ] = useState("");
  const [clientIndustry, setClientIndustry] = useState("");
  const [companyContext, setCompanyContext] = useState("");
  const [systemPrompt,   setSystemPrompt  ] = useState("");
  const [genericSubject, setGenericSubject] = useState("");
  const [genericBody,    setGenericBody   ] = useState("");
  const [followupFallbackBody, setFollowupFallbackBody] = useState("");
  const [logoPath,       setLogoPath      ] = useState<string | null>(null);
  const [logoUrl,        setLogoUrl       ] = useState<string | null>(null);
  const [logoUploading,  setLogoUploading ] = useState(false);

  const [sigContact, setSigContact] = useState("");

  const [productOfferings, setProductOfferings] = useState<ProductOffering[]>([]);

  const [replyDrafterPrompt,    setReplyDrafterPrompt   ] = useState("");

  // Personal settings (per user — campaigns you create use these; empty = inherit)
  const [myDraftPrompt, setMyDraftPrompt] = useState("");
  const [myDraftTemplate, setMyDraftTemplate] = useState("");
  const [myReplyPrompt, setMyReplyPrompt] = useState("");
  const [mySignature,   setMySignature  ] = useState("");
  const [mySenderName,  setMySenderName ] = useState("");
  const [myDefaults,    setMyDefaults   ] = useState({ draft_prompt: "", reply_prompt: "", signature: "", sender_name: "" });

  const [userEmail, setUserEmail] = useState("");
  const [userName,  setUserName  ] = useState("");

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving,  setSaving  ] = useState(false);
  const [error,   setError   ] = useState("");

  const activeAiNavItem        = aiNavItems.find((i) => i.id === aiSection);
  const activeKnowledgeSection: KnowledgeSection = isManager ? knowledgeSection : "products";
  const activeKnowledgeNavItem = KNOWLEDGE_NAV_ITEMS.find((i) => i.id === activeKnowledgeSection);
  const activeKeysNavItem      = KEYS_NAV_ITEMS.find((i) => i.id === keysSection);

  // The breadcrumb shows the ancestor trail; the deepest active item becomes the page title.
  const sectionLabel = navItems.find((n) => n.id === section)?.label ?? "Settings";
  const pageTitle =
    (section === "ai" && activeAiNavItem?.label) ||
    (section === "knowledge" && activeKnowledgeNavItem?.label) ||
    (section === "keys" && activeKeysNavItem?.label) ||
    sectionLabel;

  useEffect(() => {
    async function load() {
      setLoading(true);
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token ?? "";
        setUserEmail(session?.user?.email ?? "");
        setUserName(session?.user?.user_metadata?.full_name ?? session?.user?.user_metadata?.name ?? "");

        // Personal settings, company settings and the logo all load for everyone
        // — employees need the company settings behind Knowledge Sources, and
        // GET /settings is readable by any authenticated user.
        const myPromise = fetchMySettings(token);
        const settingsPromise = fetchSettings(token);
        const logoPromise = fetchLogo(token).catch(() => ({ logo_path: null, logo_url: null }));

        const my = await myPromise;
        // Keys nav depends on this — set it from /me/settings immediately so we
        // don't wait on company settings / logo (or a full Team users list).
        setIsSuperAdmin(my.is_super_admin);
        setMyDraftPrompt(my.draft_prompt ?? "");
        setMyDraftTemplate(my.draft_template ?? "");
        setMyReplyPrompt(my.reply_prompt ?? "");
        setMySignature(my.signature ?? "");
        setMySenderName(my.sender_name ?? "");
        setMyDefaults(my.defaults);

        const s = await settingsPromise;
        if (s) {
          setSenderName(s.default_sender_name ?? "");
          setClientIndustry(s.client_industry ?? "");
          setCompanyContext(s.company_context ?? "");
          setSystemPrompt(s.system_prompt ?? "");
          setGenericSubject(s.generic_email_subject ?? "");
          setGenericBody(s.generic_email_body ?? "");
          setFollowupFallbackBody(s.followup_fallback_body ?? "");
          setSigContact(s.signature_contact ?? "");
          setReplyDrafterPrompt(s.reply_drafter_prompt ?? "");
          try { setProductOfferings(JSON.parse(s.product_offerings ?? "[]") as ProductOffering[]); } catch { setProductOfferings([]); }
        }
        setLoading(false);

        const l = await logoPromise;
        setLogoPath(l.logo_path);
        setLogoUrl(l.logo_url);
      } catch (e) {
        setError((e as Error).message);
        setLoading(false);
      }
    }
    void load();
  }, []);

  async function handleLogoPick(file: File | null) {
    if (!file) return;
    setLogoUploading(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      const res = await uploadLogo(token, file);
      setLogoPath(res.logo_path);
      setLogoUrl(res.logo_url);
      // The upload route already wrote brand_logo_path; re-patching it here was
      // a redundant round trip. Tell the app shell instead — it renders the
      // sidebar logo and otherwise wouldn't notice until a full page reload.
      window.dispatchEvent(new CustomEvent(BRAND_LOGO_CHANGED, { detail: res.logo_url }));
      toast.success("Logo updated");
    } catch (e) { setError((e as Error).message); toast.error((e as Error).message); }
    finally { setLogoUploading(false); }
  }

  async function handleLogoRemove() {
    setLogoUploading(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";
      await removeLogo(token);
      setLogoPath(null);
      setLogoUrl(null);
      window.dispatchEvent(new CustomEvent(BRAND_LOGO_CHANGED, { detail: null }));
      toast.success("Logo removed");
    } catch (e) { setError((e as Error).message); toast.error((e as Error).message); }
    finally { setLogoUploading(false); }
  }

  const onPersonalTab = section === "ai" && (aiSection === "my-writing" || aiSection === "my-signature");

  async function handleSave() {
    // Only validate Product Offerings completeness when the user is actually on that
    // tab. Without this scoping, a stale incomplete product sitting in Knowledge
    // Sources blocks saving on completely unrelated tabs (Email Template, Reply AI,
    // Email Footer) even when nothing about products was touched — confirmed live bug.
    if (section === "knowledge" && activeKnowledgeSection === "products") {
      const incompleteProduct = productOfferings.find(
        (p) => !p.name.trim() || !p.description.trim()
      );
      if (incompleteProduct) {
        toast.error("Every product needs both a name and a description before saving.");
        return;
      }
    }

    setSaving(true);
    setError("");
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token ?? "";

      if (onPersonalTab) {
        // Personal settings — empty fields clear back to "inherit company default".
        const my = await patchMySettings(token, {
          draft_prompt: myDraftPrompt.trim() || null,
          draft_template: myDraftTemplate.trim() || null,
          reply_prompt: myReplyPrompt.trim() || null,
          signature:    mySignature.trim() || null,
          sender_name:  mySenderName.trim() || null,
        });
        setMyDefaults(my.defaults);
        toast.success("Your settings were saved");
      } else if (section === "knowledge") {
        // Send only the keys these tabs own — the prompt-shaped keys are
        // manager-only server-side and including them would 403 the save.
        // Company Details is manager-only too, so an employee sends products
        // alone; sending those keys back unchanged would 403 their whole save.
        await patchSettings(token, {
          product_offerings: JSON.stringify(productOfferings),
          ...(isManager && {
            default_sender_name: senderName,
            client_industry:     clientIndustry,
            company_context:     companyContext,
          }),
        });
        toast.success("Knowledge sources saved");
      } else {
        await patchSettings(token, {
          system_prompt:           systemPrompt,
          generic_email_subject:   genericSubject,
          generic_email_body:      genericBody,
          followup_fallback_body:  followupFallbackBody,
          signature_contact:       sigContact,
          reply_drafter_prompt:    replyDrafterPrompt,
        });
        toast.success("Company settings saved");
      }
    } catch (e) {
      toast.error((e as Error).message);
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function updateProduct(idx: number, field: keyof ProductOffering, value: string) {
    setProductOfferings((prev) => prev.map((p, i) => i === idx ? { ...p, [field]: value } : p));
  }

  function removeProduct(idx: number) {
    setProductOfferings((prev) => prev.filter((_, i) => i !== idx));
  }

  function addProduct() {
    setProductOfferings((prev) => [...prev, { name: "", description: "" }]);
  }

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    if (!userEmail) return;
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error("Passwords do not match.");
      return;
    }
    setSavingPassword(true);
    try {
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email: userEmail,
        password: currentPassword,
      });
      if (reauthError) {
        toast.error("Current password is incorrect.");
        return;
      }
      const { error } = await supabase.auth.updateUser({ password: newPassword });
      if (error) throw error;
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast.success("Password updated");
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSavingPassword(false);
    }
  }

  const contentSkeleton = loading ? (
    <div className="mx-auto w-full max-w-5xl p-8 space-y-8 animate-pulse">
      {/* Header row */}
      <div className="flex items-center justify-between border-b border-border pb-4">
        <div className="space-y-2">
          <div className="h-3 w-16 bg-border/60 rounded" />
          <div className="h-6 w-32 bg-border/60 rounded" />
        </div>
        <div className="h-6 w-20 bg-border/60 rounded-full" />
      </div>

      {/* Avatar + name row */}
      <div className="flex items-center gap-4 py-4 border-b border-border">
        <div className="size-12 rounded-md bg-border/60" />
        <div className="space-y-2">
          <div className="h-4 w-28 bg-border/60 rounded" />
          <div className="h-3 w-40 bg-border/40 rounded" />
        </div>
      </div>

      {/* Settings rows */}
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="flex items-start justify-between gap-8 py-5 border-b border-border last:border-0">
          <div className="space-y-1.5 w-48">
            <div className="h-4 w-28 bg-border/60 rounded" />
            <div className="h-3 w-full bg-border/40 rounded" />
          </div>
          <div className="h-9 flex-1 max-w-sm bg-border/40 rounded-lg" />
        </div>
      ))}
    </div>
  ) : null;

  const showSaveBar = !loading && (section === "ai" || section === "knowledge");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Breadcrumb + page title */}
      <div className="px-8 py-5 border-b border-border shrink-0">
        <div className="eyebrow flex items-center gap-1.5">
          <span>Settings</span>
          {sectionLabel !== pageTitle && (
            <><ChevronRight className="size-3" /><span>{sectionLabel}</span></>
          )}
        </div>
        <h1 className="font-display text-2xl font-semibold mt-1">{pageTitle}</h1>
      </div>

      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Primary sidebar */}
        <aside className="w-56 shrink-0 border-r border-border p-4 flex flex-col gap-1 overflow-y-auto">
          <p className="eyebrow px-2 mb-1">General</p>
          {navItems.map(({ id, label }) => (
            <Button key={id} type="button" variant="ghost" onClick={() => setSection(id)}
              className={cn("h-auto w-full justify-start px-3 py-2.5 rounded-md text-sm font-medium",
                section === id ? "bg-primary text-primary-foreground font-semibold hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50")}>
              {label}
            </Button>
          ))}
        </aside>

        {/* AI secondary sidebar */}
        {section === "ai" && (
          <aside className="w-56 shrink-0 border-r border-border p-4 flex flex-col gap-1 overflow-y-auto">
            <p className="eyebrow px-2 mb-1">Personal</p>
            {PERSONAL_AI_NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <Button key={id} type="button" variant="ghost" onClick={() => setAiSection(id)}
                className={cn("h-auto w-full justify-start gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium",
                  aiSection === id ? "bg-primary text-primary-foreground font-semibold hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50")}>
                <Icon className="size-4 shrink-0" /><span className="truncate">{label}</span>
              </Button>
            ))}
            {isManager && (
              <>
                <p className="eyebrow px-2 mb-1 mt-4">Company defaults</p>
                {COMPANY_AI_NAV_ITEMS.map(({ id, label, icon: Icon }) => (
                  <Button key={id} type="button" variant="ghost" onClick={() => setAiSection(id)}
                    className={cn("h-auto w-full justify-start gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium",
                      aiSection === id ? "bg-primary text-primary-foreground font-semibold hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50")}>
                    <Icon className="size-4 shrink-0" /><span className="truncate">{label}</span>
                  </Button>
                ))}
              </>
            )}
          </aside>
        )}

        {/* Knowledge secondary sidebar */}
        {section === "knowledge" && (
          <aside className="w-56 shrink-0 border-r border-border p-4 flex flex-col gap-1 overflow-y-auto">
            <p className="eyebrow px-2 mb-1">Knowledge Sources</p>
            {knowledgeNavItems.map(({ id, label, icon: Icon }) => (
              <Button key={id} type="button" variant="ghost" onClick={() => setKnowledgeSection(id)}
                className={cn("h-auto w-full justify-start gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium",
                  activeKnowledgeSection === id ? "bg-primary text-primary-foreground font-semibold hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50")}>
                <Icon className="size-4 shrink-0" /><span className="truncate">{label}</span>
              </Button>
            ))}
          </aside>
        )}

        {/* Keys secondary sidebar — Credentials (manage secrets) vs Usage (balances / validity) */}
        {section === "keys" && isManager && (
          <aside className="w-56 shrink-0 border-r border-border p-4 flex flex-col gap-1 overflow-y-auto">
            <p className="eyebrow px-2 mb-1">Keys</p>
            {KEYS_NAV_ITEMS.map(({ id, label, icon: Icon }) => (
              <Button key={id} type="button" variant="ghost" onClick={() => setKeysSection(id)}
                className={cn("h-auto w-full justify-start gap-2.5 px-3 py-2.5 rounded-md text-sm font-medium",
                  keysSection === id ? "bg-primary text-primary-foreground font-semibold hover:bg-primary hover:text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/50")}>
                <Icon className="size-4 shrink-0" /><span className="truncate">{label}</span>
              </Button>
            ))}
          </aside>
        )}

        {/* Content */}
        <div className="relative flex-1 overflow-y-auto">
          {contentSkeleton}

          {!loading && (
            <div className="mx-auto w-full max-w-5xl p-8 space-y-8">

              {/* ── Profile ── */}
              {section === "profile" && (
                <div className="enter">
                  <div className="flex items-center justify-between border-b border-border pb-4">
                    <div>
                      <p className="eyebrow">Account</p>
                      <h2 className="font-display text-lg font-semibold mt-0.5">My Profile</h2>
                    </div>
                    <span className="text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full bg-primary/10 text-primary border border-primary/20">
                      {isSuperAdmin ? "Super Admin" : role === "manager" ? "Manager" : role === "employee" ? "Employee" : "—"}
                    </span>
                  </div>

                  <div className="flex items-center gap-4 py-6 border-b border-border swatch-bar pl-4">
                    <div className="size-12 rounded-md bg-secondary border border-border flex items-center justify-center shrink-0">
                      <User className="size-5 text-muted-foreground" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-sm">{userName || "Admin"}</p>
                      <p className="text-xs font-mono text-muted-foreground truncate">{userEmail}</p>
                    </div>
                  </div>

                  <div>
                    <SettingsRow label="Display name" description="Managed through your Supabase auth account.">
                      <Input value={userName} onChange={(e) => setUserName(e.target.value)} placeholder="Admin" disabled className="max-w-sm" />
                    </SettingsRow>
                    <SettingsRow label="Email address" description="Managed through your Supabase auth account.">
                      <Input value={userEmail} disabled className="max-w-sm font-mono text-xs" />
                    </SettingsRow>
                  </div>

                  {/* Employees can mark themselves away (spec §2B). */}
                  {role === "employee" && <AvailabilityCard />}
                </div>
              )}

              {/* ── AI & Outreach ── */}
              {section === "ai" && (
                <div className="space-y-8 enter">
                  {aiSection === "my-writing" && (
                    <>
                      <section className="space-y-4 border-b border-border pb-8">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <PenLine className="size-4 text-muted-foreground" />
                            <div>
                              <p className="eyebrow">Writing style</p>
                              <h3 className="font-display text-base font-semibold mt-0.5">My cold-email writing style</h3>
                            </div>
                          </div>
                          <span className={cn(
                            "rounded-full border px-2.5 py-1 text-[11px] leading-none font-medium shrink-0",
                            myDraftPrompt.trim()
                              ? "border-primary/20 bg-primary/10 text-primary"
                              : "border-border bg-secondary text-muted-foreground",
                          )}>
                            <span className="translate-y-px inline-block">{myDraftPrompt.trim() ? "Personal" : "Using company default"}</span>
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground -mt-2">
                          Campaigns <strong>you create</strong> generate their emails with this prompt. Leave it empty to write with the company default — other people&apos;s campaigns are never affected by what you put here.
                        </p>
                        <RichTextEditor
                          label="My email template"
                          value={myDraftTemplate}
                          onChange={setMyDraftTemplate}
                          minHeight={260}
                          placeholder={"Paste the exact email you want sent, for example:\n\nI'm reaching out from Kuber Polyplast, an ISO 9001:2015 certified manufacturer with 30 years of experience...\n\nI came across (write about their company and what they make)\n\n- 18,000 MT annual production capacity\n- 6,670+ clients across 40+ countries\n\nPlease let us know if you have any current requirements."}
                          helper="Paste a finished email exactly as you want it sent. Every paragraph, bullet, number and closing line is reproduced as written; only the customer-specific parts change per lead. Put an instruction in round brackets — (write about their company and products) — wherever you want a sentence written about that specific customer; the bracket is replaced, never printed. Leave empty to use the drafting prompt below instead."
                        />

                        <RichTextEditor
                          label="My drafting prompt"
                          value={myDraftPrompt}
                          onChange={setMyDraftPrompt}
                          minHeight={320}
                          placeholder="Leave empty to use the company default, or write your own subject patterns, openings, offerings and tone here..."
                          helper="Company details, the product library and campaign context are appended automatically. Structure, length and tone come from this prompt, so anything you want changed you change here."
                        />
                        <MandatoryFormattingNotice />
                        {!myDraftPrompt.trim() && myDefaults.draft_prompt && (
                          <details className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                            <summary className="cursor-pointer select-none font-medium text-foreground">View the company default you&apos;re inheriting</summary>
                            <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap font-sans">{myDefaults.draft_prompt}</pre>
                          </details>
                        )}
                      </section>

                      <section className="space-y-4">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Bot className="size-4 text-muted-foreground" />
                            <div>
                              <p className="eyebrow">Writing style</p>
                              <h3 className="font-display text-base font-semibold mt-0.5">My reply writing style</h3>
                            </div>
                          </div>
                          <span className={cn(
                            "rounded-full border px-2.5 py-1 text-[11px] leading-none font-medium shrink-0",
                            myReplyPrompt.trim()
                              ? "border-primary/20 bg-primary/10 text-primary"
                              : "border-border bg-secondary text-muted-foreground",
                          )}>
                            <span className="translate-y-px inline-block">{myReplyPrompt.trim() ? "Personal" : "Using company default"}</span>
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground -mt-2">
                          AI reply suggestions for <strong>your campaigns&apos;</strong> conversations follow this prompt. Empty = company default.
                        </p>
                        <RichTextEditor
                          label="My reply prompt"
                          value={myReplyPrompt}
                          onChange={setMyReplyPrompt}
                          minHeight={220}
                          placeholder="Leave empty to use the company default reply prompt..."
                          helper="Must return JSON with subject and body. Safety rules are appended automatically."
                        />
                        <MandatoryFormattingNotice />
                        {!myReplyPrompt.trim() && myDefaults.reply_prompt && (
                          <details className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                            <summary className="cursor-pointer select-none font-medium text-foreground">View the company default you&apos;re inheriting</summary>
                            <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap font-sans">{myDefaults.reply_prompt}</pre>
                          </details>
                        )}
                      </section>
                    </>
                  )}

                  {aiSection === "my-signature" && (
                    <>
                      <section className="space-y-4 border-b border-border pb-8">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <Type className="size-4 text-muted-foreground" />
                            <div>
                              <p className="eyebrow">Signature</p>
                              <h3 className="font-display text-base font-semibold mt-0.5">My signature</h3>
                            </div>
                          </div>
                          <span className={cn(
                            "rounded-full border px-2.5 py-1 text-[11px] leading-none font-medium shrink-0",
                            mySignature.trim()
                              ? "border-primary/20 bg-primary/10 text-primary"
                              : "border-border bg-secondary text-muted-foreground",
                          )}>
                            <span className="translate-y-px inline-block">{mySignature.trim() ? "Personal" : "Using company default"}</span>
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground -mt-2">
                          Appended to every email of campaigns <strong>you create</strong> (cold emails and replies). A campaign&apos;s own signature override still wins. Empty = company footer.
                        </p>
                        <RichTextEditor
                          label="Sign-off block"
                          value={mySignature}
                          onChange={setMySignature}
                          minHeight={160}
                          singleLineBreaks
                          placeholder={"Your Name\nYour Title\nKuber Polyplast\n+91-XXXXXXXXXX"}
                        />
                        {!mySignature.trim() && myDefaults.signature && (
                          <details className="rounded-md border border-border bg-secondary/20 p-3 text-xs text-muted-foreground">
                            <summary className="cursor-pointer select-none font-medium text-foreground">View the company default you&apos;re inheriting</summary>
                            <pre className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap font-sans">{myDefaults.signature}</pre>
                          </details>
                        )}
                      </section>

                      <section>
                        <div className="flex items-center gap-2 pb-1">
                          <User className="size-4 text-muted-foreground" />
                          <div>
                            <p className="eyebrow">Sender</p>
                            <h3 className="font-display text-base font-semibold mt-0.5">My sender name</h3>
                          </div>
                        </div>
                        <SettingsRow
                          label="Sender name"
                          description={<>Pre-filled as the &quot;From&quot; name when you create a campaign. Empty = company default{myDefaults.sender_name ? ` (“${myDefaults.sender_name}”)` : ""}.</>}
                        >
                          <Input value={mySenderName} onChange={(e) => setMySenderName(e.target.value)} placeholder={myDefaults.sender_name || "Kuber Polyplast"} maxLength={200} className="max-w-sm" />
                        </SettingsRow>
                      </section>
                    </>
                  )}

                  {isManager && aiSection === "template" && (
                    <section className="space-y-4">
                      <div className="flex items-center gap-2 border-b border-border pb-4">
                        <Bot className="size-4 text-muted-foreground" />
                        <div>
                          <p className="eyebrow">Company default</p>
                          <h3 className="font-display text-base font-semibold mt-0.5">AI Writing Instructions</h3>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        The <strong>company default</strong> prompt for outreach emails — used by every campaign whose owner hasn&apos;t set a personal writing style. Put subject-line patterns, opening/closing options, offerings, key strengths, and tone here.
                      </p>
                      <RichTextEditor
                        label="Base prompt"
                        value={systemPrompt}
                        onChange={setSystemPrompt}
                        minHeight={400}
                        placeholder="Write the full email template here including subject patterns, intro options, offerings, closing..."
                        helper="Campaign-level context and matched product details are appended automatically."
                      />
                      <MandatoryFormattingNotice />
                    </section>
                  )}

                  {isManager && aiSection === "default" && (
                    <section className="space-y-4">
                      <div className="flex items-center gap-2 border-b border-border pb-4">
                        <FileText className="size-4 text-muted-foreground" />
                        <div className="flex items-center gap-1.5">
                          <div>
                            <p className="eyebrow">Fallback</p>
                            <h3 className="font-display text-base font-semibold mt-0.5">Default draft</h3>
                          </div>
                          <InfoTooltip text="Exact subject and body sent to unenriched / Input Required leads (no company profile to personalise). Enriched leads still use AI Writing Instructions. A greeting and signature are added automatically." />
                        </div>
                      </div>
                      <SettingsRow label="Subject">
                        <Input
                          value={genericSubject}
                          onChange={(e) => setGenericSubject(e.target.value)}
                          placeholder="Reliable masterbatch for {{company}}"
                          maxLength={300}
                          className="max-w-md"
                        />
                      </SettingsRow>
                      <div className="space-y-2">
                        <Label>Body</Label>
                        <HtmlRichTextEditor
                          value={genericBody}
                          onChange={setGenericBody}
                          templateVars={LEAD_TEMPLATE_VARS}
                          minHeight={220}
                          placeholder="Write the exact email body"
                        />
                      </div>
                    </section>
                  )}

                  {isManager && aiSection === "followup" && (
                    <section className="space-y-4">
                      <div className="flex items-center gap-2 border-b border-border pb-4">
                        <FileText className="size-4 text-muted-foreground" />
                        <div>
                          <p className="eyebrow">Fallback</p>
                          <h3 className="font-display text-base font-semibold mt-0.5">Follow-up fallback</h3>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Sent for any follow-up step (2, 3, …) whose lead has no AI-personalized
                        follow-up drafted yet — e.g. an AI provider outage, or a follow-up simply
                        not written before it&apos;s due. Without this, that follow-up would send
                        blank. Every lead is seeded with this text the moment a campaign sends;
                        it&apos;s automatically replaced once a personalized follow-up is drafted
                        and approved for that lead. No subject — a follow-up always threads as a
                        reply to the opening email. Placeholder:{" "}
                        <code className="rounded bg-secondary px-1 py-0.5 text-[11px] font-mono">{"{{first_name}}"}</code>.
                      </p>
                      <div className="space-y-2">
                        <Label>Body</Label>
                        <HtmlRichTextEditor
                          value={followupFallbackBody}
                          onChange={setFollowupFallbackBody}
                          minHeight={200}
                          templateVars={FOLLOWUP_FALLBACK_TEMPLATE_VARS}
                          placeholder="Hi {{first_name}}, Just following up on my previous note — would love your thoughts. Best regards"
                        />
                        <p className="text-xs text-muted-foreground">Left blank, this default text is used. This text is sent as-is — the AI does not rewrite it.</p>
                      </div>
                    </section>
                  )}

                  {isManager && aiSection === "replies" && (
                    <section className="space-y-5">
                      <div className="flex items-center gap-2 border-b border-border pb-4">
                        <Bot className="size-4 text-muted-foreground" />
                        <div>
                          <p className="eyebrow">Company default</p>
                          <h3 className="font-display text-base font-semibold mt-0.5">Reply AI</h3>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Controls how follow-up replies are drafted after a prospect responds.
                      </p>

                      <RichTextEditor label="Reply drafter prompt" value={replyDrafterPrompt} onChange={setReplyDrafterPrompt} minHeight={220}
                        helper="Must return JSON with subject and body. Still in active use — this is what writes our human-reviewed reply drafts." />
                      <MandatoryFormattingNotice />
                    </section>
                  )}

                  {isManager && aiSection === "footer" && (
                    <section className="space-y-4">
                      <div className="flex items-center gap-2 border-b border-border pb-4">
                        <PenLine className="size-4 text-muted-foreground" />
                        <div>
                          <p className="eyebrow">Company default</p>
                          <h3 className="font-display text-base font-semibold mt-0.5">Email Footer</h3>
                        </div>
                      </div>
                      <p className="text-xs text-muted-foreground">Contact lines appended at the end of every generated email.</p>
                      <RichTextEditor label="Contact footer" value={sigContact} onChange={setSigContact} minHeight={160} singleLineBreaks
                        placeholder={"Kuber Polyplast\n+91-XXXXXXXXXX\nsales@kuberpolyplast.com"} />
                    </section>
                  )}

                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
              )}

              {/* ── Knowledge Sources (everyone) ── */}
              {section === "knowledge" && (
                <div className="space-y-8 enter">

                  {/* Company Details */}
                  {activeKnowledgeSection === "company" && (
                    <section className="space-y-5">
                      <div className="flex items-center justify-between border-b border-border pb-4">
                        <div className="flex items-center gap-2">
                          <Building2 className="size-4 text-muted-foreground" />
                          <div>
                            <p className="eyebrow">Knowledge source</p>
                            <h3 className="font-display text-base font-semibold mt-0.5">Company Details</h3>
                          </div>
                        </div>
                        <span className="rounded-md bg-secondary px-2 py-1 text-[11px] font-medium text-muted-foreground">Context</span>
                      </div>

                      <div>
                        <SettingsRow label="Default sender name" description={'Used as the "From" name in outreach emails.'}>
                          <Input value={senderName} onChange={(e) => setSenderName(e.target.value)} placeholder="Kuber Polyplast" className="max-w-sm" />
                        </SettingsRow>
                        <SettingsRow label="Client industry">
                          <Input value={clientIndustry} onChange={(e) => setClientIndustry(e.target.value)} placeholder="Plastics & Polymer Manufacturing" className="max-w-sm" />
                        </SettingsRow>
                        <SettingsRow label="Logo" description="PNG/JPG/WebP, up to 2 MB. Appears in the sidebar.">
                          <div className="flex items-center gap-3 flex-wrap">
                            {logoUrl
                              ? <img src={logoUrl} alt="Brand logo" className="size-10 rounded-md border border-border bg-card object-contain shrink-0" />
                              : <div className="size-10 rounded-md border border-border bg-card flex items-center justify-center shrink-0"><span className="text-xs font-bold font-mono text-muted-foreground">K</span></div>
                            }
                            <Input
                              ref={logoInputRef}
                              type="file"
                              accept="image/png,image/jpeg,image/webp"
                              className="hidden"
                              onChange={(e) => void handleLogoPick(e.target.files?.[0] ?? null)}
                            />
                            <Button type="button" disabled={logoUploading} onClick={() => logoInputRef.current?.click()}>
                              {logoUploading ? "Uploading..." : (logoUrl ? "Replace logo" : "Upload logo")}
                            </Button>
                            {logoPath && (
                              <Button type="button" variant="outline" disabled={logoUploading} onClick={() => void handleLogoRemove()}>Remove</Button>
                            )}
                          </div>
                        </SettingsRow>
                      </div>

                      <div className="space-y-1.5">
                        <Label>Company context</Label>
                        <Textarea
                          value={companyContext}
                          onChange={(e) => setCompanyContext(e.target.value)}
                          placeholder="Who Kuber Polyplast is, what makes it credible, key accolades — background the AI can draw on in every email and reply."
                          className="min-h-32 text-sm resize-y"
                        />
                        <p className="text-xs text-muted-foreground">
                          Given to the AI as background for every draft and reply. Products belong in the Product Offerings tab — the AI reads that library directly.
                        </p>
                      </div>
                    </section>
                  )}

                  {/* Product Offerings */}
                  {activeKnowledgeSection === "products" && (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between border-b border-border pb-4">
                        <div className="flex items-center gap-2">
                          <Package className="size-4 text-muted-foreground" />
                          <div>
                            <p className="eyebrow">Knowledge source</p>
                            <h3 className="font-display text-base font-semibold mt-0.5">Product Offerings</h3>
                          </div>
                        </div>
                        <Button type="button" size="sm" onClick={addProduct} className="gap-1.5 shrink-0">
                          <Plus className="size-3.5" /> Add product
                        </Button>
                      </div>
                      <p className="text-xs text-muted-foreground -mt-2">
                        The AI picks the best-matching product for each lead and uses its description as context.
                      </p>

                      {productOfferings.length === 0 && (
                        <div className="rounded-md border border-dashed border-border bg-secondary/10 p-10 text-center text-sm text-muted-foreground">
                          No products yet — click &quot;Add product&quot; to get started.
                        </div>
                      )}

                      <div className="grid gap-3 lg:grid-cols-2">
                        {productOfferings.map((product, idx) => (
                          <div key={idx} className="swatch-bar rounded-md border border-border bg-card p-4 pl-5 space-y-3">
                            <div className="flex items-center gap-2">
                              <span className="eyebrow shrink-0">{String(idx + 1).padStart(2, "0")}</span>
                              <Input
                                value={product.name}
                                onChange={(e) => updateProduct(idx, "name", e.target.value)}
                                placeholder="Product name"
                                className="h-9 text-sm font-medium flex-1"
                              />
                              <Button type="button" variant="ghost" size="icon-sm" onClick={() => removeProduct(idx)}
                                className="shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                                <X className="size-3.5" />
                              </Button>
                            </div>
                            <Textarea
                              value={product.description}
                              onChange={(e) => updateProduct(idx, "description", e.target.value)}
                              placeholder="Describe this product — what it is, who it fits, key benefits..."
                              className="min-h-32 text-sm resize-y"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {error && <p className="text-xs text-destructive">{error}</p>}
                </div>
              )}

              {/* ── Appearance ── */}
              {section === "appearance" && (
                <div className="enter">
                  <section>
                    <div className="flex items-center gap-2 border-b border-border pb-4">
                      {mode === "light" ? <Sun className="size-4 text-muted-foreground" /> : <Moon className="size-4 text-muted-foreground" />}
                      <div>
                        <p className="eyebrow">Display</p>
                        <h3 className="font-display text-base font-semibold mt-0.5">Appearance mode</h3>
                      </div>
                    </div>
                    <SettingsRow label="Workspace mode" description="Switch between a dark or light workspace ">
                      <div className="grid grid-cols-2 gap-3 max-w-sm">
                        {(["dark", "light"] as const).map((m) => {
                          const active = mode === m;
                          const Icon = m === "dark" ? Moon : Sun;
                          return (
                            <Button key={m} type="button" variant="outline" onClick={() => void setMode(m)} disabled={savingTheme}
                              className={cn("h-auto justify-start gap-2.5 p-3 font-medium",
                                active ? "border-primary bg-primary/10 hover:bg-primary/10" : "hover:border-muted-foreground")}>
                              <Icon className="size-4 shrink-0 text-muted-foreground" />
                              <span className="flex-1 text-sm font-medium capitalize">{m}</span>
                              {active && <Check className="size-4 text-primary shrink-0" />}
                            </Button>
                          );
                        })}
                      </div>
                    </SettingsRow>
                  </section>

                  {/* Color theme — the literal "masterbatch color chip" this whole
                      design language is inspired by. The one place a larger, more
                      expressive swatch presentation is warranted. Logic/COLORS list
                      untouched — visual chrome only. */}
                  <section className="mt-8">
                    <div className="flex items-center gap-2 border-b border-border pb-4">
                      <Palette className="size-4 text-muted-foreground" />
                      <div>
                        <p className="eyebrow">Masterbatch reference</p>
                        <h3 className="font-display text-base font-semibold mt-0.5">Color theme</h3>
                      </div>
                    </div>
                    <SettingsRow label="Accent color" description="Choose an accent color for the workspace — like picking a pellet reference chip.">
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                        {COLORS.map((t) => {
                          const active = theme === t.id;
                          return (
                            <Button key={t.id} type="button" variant="outline" onClick={() => void setTheme(t.id)} disabled={savingTheme}
                              className={cn(
                                "h-auto flex-col items-stretch gap-3 p-3 text-left overflow-hidden",
                                active ? "border-primary swatch-bar-top hover:border-primary" : "hover:border-muted-foreground",
                              )}>
                              <span
                                className="block h-12 w-full rounded shrink-0 border border-black/10"
                                style={{ backgroundColor: t.swatch }}
                                aria-hidden
                              />
                              <span className="flex items-center justify-between gap-2">
                                <span className="text-sm font-medium">{t.label}</span>
                                {active && <Check className="size-4 text-primary shrink-0" />}
                              </span>
                            </Button>
                          );
                        })}
                      </div>
                    </SettingsRow>
                  </section>
                </div>
              )}

              {/* ── Account ── */}
              {section === "account" && (
                <div className="enter">
                  <section>
                    <div className="border-b border-border pb-4">
                      <p className="eyebrow">Security</p>
                      <h3 className="font-display text-base font-semibold mt-0.5">Change password</h3>
                    </div>
                    <form onSubmit={handleChangePassword}>
                      <SettingsRow label="Current password">
                        <Input
                          type="password"
                          value={currentPassword}
                          onChange={(e) => setCurrentPassword(e.target.value)}
                          required
                          autoComplete="current-password"
                          className="max-w-sm"
                        />
                      </SettingsRow>
                      <SettingsRow label="New password" description="At least 8 characters.">
                        <Input
                          type="password"
                          value={newPassword}
                          onChange={(e) => setNewPassword(e.target.value)}
                          required
                          minLength={8}
                          autoComplete="new-password"
                          className="max-w-sm"
                        />
                      </SettingsRow>
                      <SettingsRow label="Confirm password">
                        <Input
                          type="password"
                          value={confirmPassword}
                          onChange={(e) => setConfirmPassword(e.target.value)}
                          required
                          minLength={8}
                          autoComplete="new-password"
                          className="max-w-sm"
                        />
                      </SettingsRow>
                      <div className="flex justify-end pt-5">
                        <Button type="submit" disabled={savingPassword}>
                          {savingPassword ? "Updating…" : "Update password"}
                        </Button>
                      </div>
                    </form>
                  </section>

                  <section className="mt-8">
                    <div className="border-b border-border pb-4">
                      <p className="eyebrow">Account</p>
                      <h3 className="font-display text-base font-semibold mt-0.5">Session</h3>
                    </div>
                    <SettingsRow label="Signed in as" description={<span className="font-mono">{userEmail}</span>}>
                      <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-green-500/10 text-green-400 border border-green-500/20">Active</span>
                    </SettingsRow>
                    <SettingsRow label="Sign out" description="End your current session on this device.">
                      <Button type="button" variant="outline" onClick={() => supabase.auth.signOut()}
                        className="gap-2 text-muted-foreground hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/5">
                        <LogOut className="size-3.5" /> Sign out
                      </Button>
                    </SettingsRow>
                  </section>
                </div>
              )}

              {section === "team" && role === "manager" && (
                <div className="-m-8">
                  <TeamView />
                </div>
              )}

              {section === "email" && isManager && (
                <div className="-m-8">
                  <EmailSendingView />
                </div>
              )}

              {section === "keys" && isManager && keysSection === "credentials" && (
                <div className="-m-8">
                  <KeysView />
                </div>
              )}

              {section === "keys" && isManager && keysSection === "usage" && (
                <div className="-m-8">
                  <KeysUsageView />
                </div>
              )}

            </div>
          )}

          {showSaveBar && (
            <div className="sticky bottom-0 flex justify-end border-t border-border bg-background/95 px-8 py-4 backdrop-blur">
              <Button onClick={handleSave} disabled={saving} className="min-w-24">
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

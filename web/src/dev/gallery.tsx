// SPDX-License-Identifier: AGPL-3.0-only
//
// Development-only component gallery (/dev/gallery). Not part of production
// builds. Every interactive element here is measured by e2e/target-size.spec.ts
// in light/dark x compact/comfortable, for fine and coarse pointers.

import { useState, type ReactNode } from 'react';
import { Link, useRouterState } from '@tanstack/react-router';
import { HashIcon, PanelRightIcon, PlusIcon, SaveIcon, Trash2Icon, XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@cenacle/ui/components/button';
import { ConfirmDialog } from '@cenacle/ui/components/confirm-dialog';
import { ErrorState, InlineError } from '@cenacle/ui/components/error-state';
import { Input } from '@cenacle/ui/components/input';
import { Kbd, KbdGroup } from '@cenacle/ui/components/kbd';
import { Label } from '@cenacle/ui/components/label';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  usePanelRef,
} from '@cenacle/ui/components/resizable';
import { ScrollArea } from '@cenacle/ui/components/scroll-area';
import { Separator } from '@cenacle/ui/components/separator';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from '@cenacle/ui/components/sidebar';
import { Skeleton } from '@cenacle/ui/components/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@cenacle/ui/components/tooltip';
import { showUndoToast } from '@cenacle/ui/components/undo-toast';
import { useDensity, useTheme } from '@cenacle/ui/theme';
import { BrandSection } from './brand-section';
import i18next from 'i18next';
import galleryEn from './i18n/en.json';
import galleryTr from './i18n/tr.json';

// Gallery texts ship only with this dev-only module.
i18next.addResourceBundle('en', 'app', galleryEn, true, true);
i18next.addResourceBundle('tr', 'app', galleryTr, true, true);

const VARIANTS = [
  { theme: 'light', density: 'comfortable' },
  { theme: 'light', density: 'compact' },
  { theme: 'dark', density: 'comfortable' },
  { theme: 'dark', density: 'compact' },
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} data-gallery-section className="flex flex-col gap-3">
      <h2 id={id} className="text-sm font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
      </h2>
      <div className="rounded-xl border bg-card p-4">{children}</div>
    </section>
  );
}

function VariantSwitcher() {
  const { t } = useTranslation();
  const { resolvedTheme } = useTheme();
  const { resolvedDensity } = useDensity();
  return (
    <nav aria-label={t('gallery.variant')} className="flex flex-wrap gap-2">
      {VARIANTS.map((v) => {
        const current = v.theme === resolvedTheme && v.density === resolvedDensity;
        return (
          <Button
            key={`${v.theme}-${v.density}`}
            variant={current ? 'default' : 'outline'}
            size="sm"
            nativeButton={false}
            render={
              <Link to="/dev/gallery" search={v} aria-current={current ? 'page' : undefined} />
            }
          >
            {v.theme} / {v.density}
          </Button>
        );
      })}
    </nav>
  );
}

function ButtonsSection() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button>
          <SaveIcon strokeWidth={1.75} />
          {t('gallery.samples.save')}
        </Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="destructive">
          <Trash2Icon strokeWidth={1.75} />
          {t('gallery.samples.delete')}
        </Button>
        <Button variant="link">Link</Button>
        <Button disabled>Disabled</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="xs">xs</Button>
        <Button size="sm">sm</Button>
        <Button size="default">default</Button>
        <Button size="lg">lg</Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="icon-xs" variant="outline" aria-label="icon-xs">
          <XIcon />
        </Button>
        <Button size="icon-sm" variant="outline" aria-label="icon-sm">
          <PlusIcon />
        </Button>
        <Button size="icon" variant="outline" aria-label="icon">
          <PlusIcon />
        </Button>
        <Button size="icon-lg" variant="outline" aria-label="icon-lg">
          <PlusIcon />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Text with an {/* Inline links are exempt from target size (WCAG 2.5.8 inline exception). */}
        <a href="#buttons" data-target-exempt="inline" className="underline underline-offset-3">
          {t('gallery.samples.inlineLink')}
        </a>
        .
      </p>
    </div>
  );
}

function InputsSection() {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  // Errors appear after the user leaves the field, not while they start typing.
  const invalid = touched && value.trim() === '';
  return (
    <div className="flex max-w-sm flex-col gap-2">
      <Label htmlFor="gallery-name">{t('gallery.samples.nameLabel')}</Label>
      <Input
        id="gallery-name"
        value={value}
        onChange={(e) => setValue(e.currentTarget.value)}
        onBlur={() => setTouched(true)}
        placeholder={t('gallery.samples.namePlaceholder')}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? 'gallery-name-error' : undefined}
      />
      {invalid && <InlineError id="gallery-name-error" title={t('gallery.samples.nameError')} />}
    </div>
  );
}

function TooltipKbdSection() {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Tooltip>
        <TooltipTrigger render={<Button variant="outline" />}>Hover or focus me</TooltipTrigger>
        <TooltipContent>
          Search <Kbd>Ctrl K</Kbd>
        </TooltipContent>
      </Tooltip>
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <Kbd>Shift</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
      <Kbd>Esc</Kbd>
    </div>
  );
}

function FeedbackSection() {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex h-6 items-center gap-3 text-sm">
        <span>Left</span>
        <Separator orientation="vertical" />
        <span>Right</span>
      </div>
      <Separator />
      <div className="flex gap-3">
        <Skeleton className="size-9 rounded-lg" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-3.5 w-3/4" />
        </div>
      </div>
    </div>
  );
}

function ScrollAreaSection() {
  return (
    <ScrollArea className="h-40 rounded-lg border">
      <ul className="p-3 text-sm">
        {Array.from({ length: 30 }, (_, i) => (
          <li key={i} className="py-1">
            Item {i + 1}
          </li>
        ))}
      </ul>
    </ScrollArea>
  );
}

function SidebarSection() {
  const [active, setActive] = useState('general');
  return (
    <SidebarProvider className="min-h-0 w-full max-w-xs" defaultOpen>
      <Sidebar collapsible="none" className="h-auto w-full rounded-lg border">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Channels</SidebarGroupLabel>
            <SidebarGroupAction aria-label="Add channel">
              <PlusIcon />
            </SidebarGroupAction>
            <SidebarGroupContent>
              <SidebarMenu>
                {['general', 'ops-alerts', 'deploys'].map((c) => (
                  <SidebarMenuItem key={c}>
                    <SidebarMenuButton isActive={active === c} onClick={() => setActive(c)}>
                      <HashIcon strokeWidth={1.75} />
                      <span>{c}</span>
                    </SidebarMenuButton>
                    {c === 'ops-alerts' ? (
                      <SidebarMenuBadge className="rounded-full bg-mention px-1.5 text-mention-foreground">
                        3
                      </SidebarMenuBadge>
                    ) : (
                      <SidebarMenuAction showOnHover aria-label={`Options for ${c}`}>
                        <XIcon />
                      </SidebarMenuAction>
                    )}
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
}

function ResizableSection() {
  const { t } = useTranslation();
  const right = usePanelRef();
  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => {
          const p = right.current;
          if (!p) return;
          if (p.isCollapsed()) p.expand();
          else p.collapse();
        }}
      >
        <PanelRightIcon strokeWidth={1.75} />
        {t('gallery.samples.toggleRight')}
      </Button>
      <div className="h-36 rounded-lg border">
        <ResizablePanelGroup orientation="horizontal" id="gallery-resizable">
          <ResizablePanel id="gallery-left" minSize={80}>
            <div className="flex h-full items-center justify-center text-sm">
              {t('gallery.samples.leftPanel')}
            </div>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel
            id="gallery-right"
            panelRef={right}
            collapsible
            minSize={80}
            defaultSize="40"
          >
            <div className="flex h-full items-center justify-center text-sm">
              {t('gallery.samples.rightPanel')}
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </div>
  );
}

function ToastsSection() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" onClick={() => toast(t('gallery.samples.toastMessage'))}>
        {t('gallery.samples.showToast')}
      </Button>
      <Button
        variant="outline"
        data-testid="undo-toast-trigger"
        onClick={() =>
          showUndoToast({
            message: t('gallery.samples.messageDeleted'),
            onUndo: () => {
              toast(t('gallery.samples.undone'));
            },
          })
        }
      >
        <Trash2Icon strokeWidth={1.75} />
        {t('gallery.samples.deleteMessage')}
      </Button>
    </div>
  );
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function ConfirmSection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState<'s2' | 's3' | null>(null);
  const channel = 'ops-alerts';
  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" data-testid="confirm-s2-trigger" onClick={() => setOpen('s2')}>
        {t('gallery.samples.archiveChannel')}…
      </Button>
      <Button variant="destructive" data-testid="confirm-s3-trigger" onClick={() => setOpen('s3')}>
        <Trash2Icon strokeWidth={1.75} />
        {t('gallery.samples.deleteChannel')}…
      </Button>

      <ConfirmDialog
        open={open === 's2'}
        onOpenChange={(o) => setOpen(o ? 's2' : null)}
        severity="s2"
        title={t('gallery.samples.archiveTitle', { channel })}
        description={<p>{t('gallery.samples.archiveDescription')}</p>}
        impact={t('gallery.samples.archiveImpact')}
        confirmLabel={t('gallery.samples.archiveChannel')}
        onConfirm={async () => {
          await wait(600);
          showUndoToast({ message: t('gallery.samples.archived', { channel }), onUndo: () => {} });
        }}
      />
      <ConfirmDialog
        open={open === 's3'}
        onOpenChange={(o) => setOpen(o ? 's3' : null)}
        severity="s3"
        title={t('gallery.samples.deleteTitle', { channel })}
        description={<p>{t('gallery.samples.deleteDescription')}</p>}
        impact={t('gallery.samples.deleteImpact')}
        confirmLabel={t('gallery.samples.deleteChannel')}
        confirmationText={channel}
        onConfirm={() => wait(600)}
      />
    </div>
  );
}

function ErrorsSection() {
  const { t } = useTranslation();
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-lg border">
        <ErrorState
          problem={{ status: 500, code: 'internal_error', request_id: 'REQ-8F3A2KQ7' }}
          actions={<Button variant="outline">{t('ui:errors.retry')}</Button>}
        />
      </div>
      <div className="rounded-lg border">
        <ErrorState
          politeness="status"
          problem={{ status: 429, code: 'rate_limited' }}
          values={{ seconds: 30 }}
        />
      </div>
      <InlineError
        className="md:col-span-2"
        problem={{ status: 403, code: 'forbidden', request_id: 'REQ-Q2W4E6R8' }}
      />
    </div>
  );
}

export function Gallery() {
  const { t } = useTranslation();
  const search = useRouterState({ select: (s) => s.location.searchStr });
  return (
    <div className="min-h-full bg-background text-foreground" data-gallery={search || 'default'}>
      <main className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-8 sm:px-6">
        <header className="flex flex-col gap-3">
          <h1 className="text-2xl font-semibold">{t('gallery.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('gallery.subtitle')}</p>
          <VariantSwitcher />
        </header>
        <Section id="brand" title={t('gallery.sections.brand')}>
          <BrandSection />
        </Section>
        <Section id="buttons" title={t('gallery.sections.buttons')}>
          <ButtonsSection />
        </Section>
        <Section id="inputs" title={t('gallery.sections.inputs')}>
          <InputsSection />
        </Section>
        <Section id="tooltip" title={t('gallery.sections.tooltipKbd')}>
          <TooltipKbdSection />
        </Section>
        <Section id="feedback" title={t('gallery.sections.feedback')}>
          <FeedbackSection />
        </Section>
        <Section id="scroll" title={t('gallery.sections.scrollArea')}>
          <ScrollAreaSection />
        </Section>
        <Section id="sidebar" title={t('gallery.sections.sidebar')}>
          <SidebarSection />
        </Section>
        <Section id="resizable" title={t('gallery.sections.resizable')}>
          <ResizableSection />
        </Section>
        <Section id="toasts" title={t('gallery.sections.toasts')}>
          <ToastsSection />
        </Section>
        <Section id="confirm" title={t('gallery.sections.confirm')}>
          <ConfirmSection />
        </Section>
        <Section id="errors" title={t('gallery.sections.errors')}>
          <ErrorsSection />
        </Section>
      </main>
    </div>
  );
}

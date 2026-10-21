// SPDX-License-Identifier: Apache-2.0
// Cenacle ID texts (English default, Turkish). Wording follows docs/ux/glossary.md.

export const LOCALES = ['en', 'tr'] as const;
export type Locale = (typeof LOCALES)[number];

const en = {
  productName: 'Cenacle ID',
  skipToContent: 'Skip to content',
  language: 'Language',
  login: {
    title: 'Sign in',
    subtitle: 'to continue to {client}',
    email: 'E-mail address',
    password: 'Password',
    submit: 'Sign in',
    cancel: 'Cancel sign-in',
    invalid: 'E-mail address or password is incorrect.',
    invalidAction: 'Check both and try again.',
    missing: 'Enter your e-mail address and password.',
    rateLimited: 'Too many attempts.',
    rateLimitedAction: 'Wait {seconds} seconds and try again.',
  },
  logout: {
    title: 'Sign out of Cenacle?',
    body: 'You will be signed out on this device.',
    confirm: 'Sign out',
    stay: 'Stay signed in',
    doneTitle: "You're signed out.",
    doneBody: 'You can close this page.',
  },
  error: {
    title: 'Sign-in could not continue.',
    reason: 'The request was invalid or has expired.',
    action: 'Go back to the app and start signing in again.',
    code: 'Error code',
    requestId: 'Request ID',
    unsupported: 'This application is not set up for Cenacle ID yet.',
  },
};

type Messages = typeof en;

const tr: Messages = {
  productName: 'Cenacle ID',
  skipToContent: 'İçeriğe geç',
  language: 'Dil',
  login: {
    title: 'Giriş yap',
    subtitle: '{client} ile devam etmek için',
    email: 'E-posta adresi',
    password: 'Parola',
    submit: 'Giriş yap',
    cancel: 'Girişten vazgeç',
    invalid: 'E-posta adresi veya parola hatalı.',
    invalidAction: 'İkisini de kontrol edip tekrar dene.',
    missing: 'E-posta adresini ve parolanı gir.',
    rateLimited: 'Çok fazla deneme yapıldı.',
    rateLimitedAction: '{seconds} saniye bekleyip tekrar dene.',
  },
  logout: {
    title: "Cenacle'dan çıkış yapılsın mı?",
    body: 'Bu cihazdaki oturumun kapatılacak.',
    confirm: 'Çıkış yap',
    stay: 'Oturumu açık tut',
    doneTitle: 'Çıkış yaptın.',
    doneBody: 'Bu sayfayı kapatabilirsin.',
  },
  error: {
    title: 'Giriş devam edemedi.',
    reason: 'İstek geçersiz ya da süresi dolmuş.',
    action: 'Uygulamaya dönüp girişi yeniden başlat.',
    code: 'Hata kodu',
    requestId: 'İstek kimliği',
    unsupported: 'Bu uygulama henüz Cenacle ID için yapılandırılmadı.',
  },
};

export const MESSAGES: Record<Locale, Messages> = { en, tr };

export function isLocale(v: unknown): v is Locale {
  return LOCALES.includes(v as Locale);
}

/**
 * Picks the language: explicit choice (cookie or ui_locales), then the
 * browser's Accept-Language, then English.
 */
export function pickLocale(
  explicit: string | undefined,
  acceptLanguage: string | undefined,
): Locale {
  for (const tag of (explicit ?? '').split(/\s+/)) {
    const base = tag.slice(0, 2).toLowerCase();
    if (isLocale(base)) return base;
  }
  const ranked = (acceptLanguage ?? '')
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = Number(params.find((p) => p.trim().startsWith('q='))?.split('=')[1] ?? 1);
      return { base: tag.slice(0, 2).toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .sort((a, b) => b.q - a.q);
  return (ranked.find((r) => isLocale(r.base))?.base as Locale | undefined) ?? 'en';
}

export function format(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(values[k] ?? `{${k}}`));
}

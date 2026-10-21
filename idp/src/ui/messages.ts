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
  mfa: {
    title: 'Two-step verification',
    subtitle: 'Enter the 6-digit code from your authenticator app.',
    code: 'Verification code',
    codeHint: 'Or one of your recovery codes, like k7f3m-2qx9a.',
    submit: 'Verify',
    cancel: 'Cancel sign-in',
    invalid: 'The code was not accepted.',
    invalidAction:
      'Codes change every 30 seconds and work once; check the time on your device. {attempts} attempts left.',
    invalidShort: 'Codes change every 30 seconds and work once; check the time on your device.',
    expired: 'This sign-in has expired.',
    expiredAction: 'Start signing in again.',
    lostDevice: 'No access to your app? Enter a recovery code instead.',
  },
  account: {
    title: 'Your Cenacle ID',
    signinTitle: 'Sign in to your account',
    signinSubtitle: 'Manage your second step and see recent activity.',
    back: 'Back to Cenacle',
    signOut: 'Sign out of Cenacle ID',
    signedOut: 'You are signed out of your account page.',
    twoStep: 'Two-step verification',
    twoStepOn: 'On. Signing in needs a code from your authenticator app.',
    twoStepOff: 'Off. Turn it on so a stolen password alone is not enough.',
    recoveryLeft: '{count} recovery codes left.',
    setUp: 'Set up two-step verification',
    turnOff: 'Turn off two-step verification',
    newCodes: 'Create new recovery codes',
    setupTitle: 'Set up two-step verification',
    setupStep1:
      'Scan this code with an authenticator app (for example Aegis, Google Authenticator, 1Password).',
    setupStep2: 'Or enter this key in the app by hand:',
    setupStep3: 'Enter the 6-digit code the app shows to finish.',
    qrLabel: 'QR code for your authenticator app',
    confirm: 'Turn on two-step verification',
    cancel: 'Cancel',
    codesTitle: 'Save your recovery codes',
    codesBody:
      'Each code signs you in once if you lose your phone. They are shown only now: print them or keep them in a password manager.',
    codesDone: 'I have saved the codes',
    turnOffTitle: 'Turn off two-step verification?',
    turnOffBody:
      'Signing in will need only your password. Your recovery codes stop working. Enter a current code to confirm.',
    newCodesTitle: 'Create new recovery codes?',
    newCodesBody: 'Your current recovery codes stop working. Enter a current code to confirm.',
    activity: 'Recent activity',
    noActivity: 'No activity yet.',
    actions: {
      'signin.succeeded': 'Signed in',
      'signin.failed': 'Sign-in failed',
      'signin.second_step_failed': 'Second step failed',
      'recovery_code.used': 'Recovery code used',
      'two_step.enabled': 'Two-step verification turned on',
      'two_step.disabled': 'Two-step verification turned off',
      'recovery_codes.regenerated': 'New recovery codes created',
      'account.signed_in': 'Signed in to the account page',
      'account.signed_out': 'Signed out of the account page',
    } as Record<string, string>,
    enabledNotice: 'Two-step verification is on.',
    disabledNotice: 'Two-step verification is off.',
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
  mfa: {
    title: 'İki adımlı doğrulama',
    subtitle: 'Doğrulama uygulamandaki 6 haneli kodu gir.',
    code: 'Doğrulama kodu',
    codeHint: 'Ya da kurtarma kodlarından birini, örneğin k7f3m-2qx9a.',
    submit: 'Doğrula',
    cancel: 'Girişten vazgeç',
    invalid: 'Kod kabul edilmedi.',
    invalidAction:
      'Kodlar 30 saniyede bir değişir ve bir kez geçerlidir; cihazının saatini kontrol et. {attempts} deneme hakkın kaldı.',
    invalidShort:
      'Kodlar 30 saniyede bir değişir ve bir kez geçerlidir; cihazının saatini kontrol et.',
    expired: 'Bu girişin süresi doldu.',
    expiredAction: 'Girişi yeniden başlat.',
    lostDevice: 'Uygulamana erişemiyor musun? Bunun yerine bir kurtarma kodu gir.',
  },
  account: {
    title: 'Cenacle ID hesabın',
    signinTitle: 'Hesabına giriş yap',
    signinSubtitle: 'İkinci adımını yönet ve son etkinliklerini gör.',
    back: "Cenacle'a dön",
    signOut: "Cenacle ID'den çıkış yap",
    signedOut: 'Hesap sayfasından çıkış yaptın.',
    twoStep: 'İki adımlı doğrulama',
    twoStepOn: 'Açık. Giriş için doğrulama uygulamandaki kod gerekir.',
    twoStepOff: 'Kapalı. Çalınan bir parola tek başına yetmesin diye aç.',
    recoveryLeft: '{count} kurtarma kodu kaldı.',
    setUp: 'İki adımlı doğrulamayı kur',
    turnOff: 'İki adımlı doğrulamayı kapat',
    newCodes: 'Yeni kurtarma kodları oluştur',
    setupTitle: 'İki adımlı doğrulamayı kur',
    setupStep1:
      'Bu kodu bir doğrulama uygulamasıyla tara (örneğin Aegis, Google Authenticator, 1Password).',
    setupStep2: 'Ya da bu anahtarı uygulamaya elle gir:',
    setupStep3: 'Bitirmek için uygulamanın gösterdiği 6 haneli kodu gir.',
    qrLabel: 'Doğrulama uygulaman için QR kodu',
    confirm: 'İki adımlı doğrulamayı aç',
    cancel: 'Vazgeç',
    codesTitle: 'Kurtarma kodlarını sakla',
    codesBody:
      'Telefonunu kaybedersen her kod bir kez giriş yaptırır. Yalnızca şimdi gösterilirler: yazdır ya da bir parola yöneticisinde sakla.',
    codesDone: 'Kodları sakladım',
    turnOffTitle: 'İki adımlı doğrulama kapatılsın mı?',
    turnOffBody:
      'Giriş için yalnızca parolan yeterli olacak. Kurtarma kodların çalışmaz olur. Onaylamak için güncel bir kod gir.',
    newCodesTitle: 'Yeni kurtarma kodları oluşturulsun mu?',
    newCodesBody: 'Mevcut kurtarma kodların çalışmaz olur. Onaylamak için güncel bir kod gir.',
    activity: 'Son etkinlikler',
    noActivity: 'Henüz etkinlik yok.',
    actions: {
      'signin.succeeded': 'Giriş yapıldı',
      'signin.failed': 'Giriş başarısız',
      'signin.second_step_failed': 'İkinci adım başarısız',
      'recovery_code.used': 'Kurtarma kodu kullanıldı',
      'two_step.enabled': 'İki adımlı doğrulama açıldı',
      'two_step.disabled': 'İki adımlı doğrulama kapatıldı',
      'recovery_codes.regenerated': 'Yeni kurtarma kodları oluşturuldu',
      'account.signed_in': 'Hesap sayfasına giriş yapıldı',
      'account.signed_out': 'Hesap sayfasından çıkış yapıldı',
    } as Record<string, string>,
    enabledNotice: 'İki adımlı doğrulama açık.',
    disabledNotice: 'İki adımlı doğrulama kapalı.',
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

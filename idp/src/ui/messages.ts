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
    identifier: 'E-mail address or username',
    invalidIdentifier: 'The username, e-mail address or password is incorrect.',
    missingIdentifier: 'Enter your username or e-mail address and your password.',
    unavailable: 'The company directory could not be reached.',
    unavailableAction: 'Try again in a moment.',
    rateLimited: 'Too many attempts.',
    rateLimitedAction: 'Wait {seconds} seconds and try again.',
    passkey: 'Sign in with a passkey',
    or: 'or',
    passkeyFailed: 'Signing in with a passkey did not work.',
    passkeyFailedAction: 'Try again, or use your password.',
    passkeyCancelled: 'Signing in with a passkey was cancelled.',
    continueWith: 'Continue with {provider}',
    federationFailed: 'Signing in with the other provider did not work.',
    federationFailedAction: 'Try again, or ask your administrator.',
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
    profile: 'Profile',
    displayName: 'Your name',
    saveName: 'Save name',
    nameSaved: 'Your name is saved. Cenacle shows it within a minute.',
    nameInvalid: 'Enter a name of up to 100 characters.',
    continue: 'Continue to your account',
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
    passkeys: 'Passkeys',
    passkeysBody:
      'Sign in with your fingerprint, face or device PIN instead of a password. Passkeys cannot be phished.',
    noPasskeys: 'No passkeys yet.',
    passkeyName: 'Name of the passkey',
    passkeyNameHint: 'For example the device or password manager it is on.',
    addPasskey: 'Add a passkey',
    remove: 'Remove',
    removePasskey: 'Remove {name}',
    passkeyCreated: 'Added {date}',
    passkeyUsed: 'last used {date}',
    passkeySynced: 'synced',
    passkeyAdded: 'The passkey is added.',
    passkeyRemoved: 'The passkey is removed.',
    passkeyFailed: 'The passkey could not be added.',
    passkeyFailedAction: 'Try again; your device may not support passkeys.',
    passkeyLimit: 'This account has as many passkeys as it can have. Remove one first.',
    passkeyCancelled: 'Adding the passkey was cancelled.',
    actions: {
      'signin.succeeded': 'Signed in',
      'signin.failed': 'Sign-in failed',
      'signin.second_step_failed': 'Second step failed',
      'signin.passkey_failed': 'Passkey sign-in failed',
      'signin.federation_failed': 'Sign-in with another provider failed',
      'passkey.added': 'Passkey added',
      'account.name_changed': 'Name changed',
      'passkey.removed': 'Passkey removed',
      'recovery_code.used': 'Recovery code used',
      'two_step.enabled': 'Two-step verification turned on',
      'two_step.disabled': 'Two-step verification turned off',
      'recovery_codes.regenerated': 'New recovery codes created',
      'account.signed_in': 'Signed in to the account page',
      'account.signed_out': 'Signed out of the account page',
      'admin.account.disable': 'Disabled an account (administration)',
      'admin.account.enable': 'Enabled an account (administration)',
      'admin.account.reset_two_step':
        "Turned off an account's two-step verification (administration)",
      'admin.account.make_admin': 'Made an account an administrator',
      'admin.account.remove_admin': 'Removed an administrator',
      'admin.directory.created': 'Connected a directory',
      'admin.directory.updated': 'Changed directory settings',
      'admin.directory.synced': 'Synchronized a directory',
      'admin.provider.created': 'Added an identity provider',
      'admin.provider.updated': 'Changed identity provider settings',
    } as Record<string, string>,
    administration: 'Administration',
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
    identifier: 'E-posta adresi veya kullanıcı adı',
    invalidIdentifier: 'Kullanıcı adı, e-posta adresi veya parola hatalı.',
    missingIdentifier: 'Kullanıcı adını veya e-posta adresini ve parolanı gir.',
    unavailable: 'Şirket dizinine ulaşılamadı.',
    unavailableAction: 'Birazdan yeniden dene.',
    rateLimited: 'Çok fazla deneme yapıldı.',
    rateLimitedAction: '{seconds} saniye bekleyip tekrar dene.',
    passkey: 'Geçiş anahtarıyla giriş yap',
    or: 'veya',
    passkeyFailed: 'Geçiş anahtarıyla giriş olmadı.',
    passkeyFailedAction: 'Yeniden dene ya da parolanı kullan.',
    passkeyCancelled: 'Geçiş anahtarıyla giriş iptal edildi.',
    continueWith: '{provider} ile devam et',
    federationFailed: 'Diğer sağlayıcıyla giriş olmadı.',
    federationFailedAction: 'Yeniden dene ya da yöneticine danış.',
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
    profile: 'Profil',
    displayName: 'Adın',
    saveName: 'Adı kaydet',
    nameSaved: 'Adın kaydedildi. Cenacle bir dakika içinde gösterir.',
    nameInvalid: 'En çok 100 karakterlik bir ad gir.',
    continue: 'Hesabına devam et',
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
    passkeys: 'Geçiş anahtarları',
    passkeysBody:
      'Parola yerine parmak izin, yüzün ya da cihaz PIN’inle giriş yap. Geçiş anahtarları oltalamayla ele geçirilemez.',
    noPasskeys: 'Henüz geçiş anahtarı yok.',
    passkeyName: 'Geçiş anahtarının adı',
    passkeyNameHint: 'Örneğin bulunduğu cihaz ya da parola yöneticisi.',
    addPasskey: 'Geçiş anahtarı ekle',
    remove: 'Kaldır',
    removePasskey: '{name} anahtarını kaldır',
    passkeyCreated: '{date} tarihinde eklendi',
    passkeyUsed: 'son kullanım {date}',
    passkeySynced: 'eşitleniyor',
    passkeyAdded: 'Geçiş anahtarı eklendi.',
    passkeyRemoved: 'Geçiş anahtarı kaldırıldı.',
    passkeyFailed: 'Geçiş anahtarı eklenemedi.',
    passkeyFailedAction: 'Yeniden dene; cihazın geçiş anahtarlarını desteklemiyor olabilir.',
    passkeyLimit: 'Bu hesap olabilecek en çok geçiş anahtarına sahip. Önce birini kaldır.',
    passkeyCancelled: 'Geçiş anahtarı ekleme iptal edildi.',
    actions: {
      'signin.succeeded': 'Giriş yapıldı',
      'signin.failed': 'Giriş başarısız',
      'signin.second_step_failed': 'İkinci adım başarısız',
      'signin.passkey_failed': 'Geçiş anahtarıyla giriş başarısız',
      'signin.federation_failed': 'Başka bir sağlayıcıyla giriş başarısız',
      'passkey.added': 'Geçiş anahtarı eklendi',
      'account.name_changed': 'Ad değiştirildi',
      'passkey.removed': 'Geçiş anahtarı kaldırıldı',
      'recovery_code.used': 'Kurtarma kodu kullanıldı',
      'two_step.enabled': 'İki adımlı doğrulama açıldı',
      'two_step.disabled': 'İki adımlı doğrulama kapatıldı',
      'recovery_codes.regenerated': 'Yeni kurtarma kodları oluşturuldu',
      'account.signed_in': 'Hesap sayfasına giriş yapıldı',
      'account.signed_out': 'Hesap sayfasından çıkış yapıldı',
      'admin.account.disable': 'Bir hesap devre dışı bırakıldı (yönetim)',
      'admin.account.enable': 'Bir hesap etkinleştirildi (yönetim)',
      'admin.account.reset_two_step': 'Bir hesabın iki adımlı doğrulaması kapatıldı (yönetim)',
      'admin.account.make_admin': 'Bir hesap yönetici yapıldı',
      'admin.account.remove_admin': 'Bir yönetici yöneticilikten çıkarıldı',
      'admin.directory.created': 'Bir dizin bağlandı',
      'admin.directory.updated': 'Dizin ayarları değiştirildi',
      'admin.directory.synced': 'Bir dizin eşitlendi',
      'admin.provider.created': 'Bir kimlik sağlayıcısı eklendi',
      'admin.provider.updated': 'Kimlik sağlayıcısı ayarları değiştirildi',
    } as Record<string, string>,
    administration: 'Yönetim',
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

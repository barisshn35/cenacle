// SPDX-License-Identifier: AGPL-3.0-only
import { app } from 'electron';

// Texts of the app's own parts (menus, dialogs, the pairing and offline
// pages); everything else is the web app, in the language chosen there.
const en = {
  appName: 'Cenacle',
  menu: {
    file: 'File',
    changeServer: 'Change server…',
    signOut: 'Sign out',
    closeToTray: 'Keep running in the tray when closed',
    quit: 'Quit Cenacle',
    edit: 'Edit',
    view: 'View',
    reload: 'Reload',
    actualSize: 'Actual size',
    zoomIn: 'Zoom in',
    zoomOut: 'Zoom out',
    fullScreen: 'Full screen',
    window: 'Window',
    help: 'Help',
    about: 'About Cenacle',
    checkUpdates: 'Check for updates…',
    show: 'Show Cenacle',
  },
  pair: {
    title: 'Connect to your Cenacle server',
    lede: 'Enter the address of your organization’s Cenacle server. Your IT department gives you this address.',
    address: 'Server address',
    example: 'For example chat.yourcompany.com',
    connect: 'Continue',
    connecting: 'Checking the server…',
    recent: 'Used before',
    remove: 'Remove {{origin}} from the list',
    next: 'Next you sign in with your username and password, then a code from your authenticator app.',
    errors: {
      invalid: 'This is not a server address. Check it and try again.',
      insecure: 'The server must use https. Plain http works only for this computer (localhost).',
      unreachable: 'The server cannot be reached. Check the address and your connection.',
      notCenacle: 'This address does not answer like a Cenacle server.',
      tooOld: 'This server needs Cenacle {{version}} or newer. Update the app first.',
    },
  },
  signIn: {
    title: 'Sign in to {{host}}',
    failedTitle: 'Signing in did not work',
    failed: {
      cancelled: 'Signing in was cancelled.',
      expired: 'The sign-in took too long. Try again.',
      failed: 'The answer of Cenacle ID could not be verified. Try again.',
      unavailable: 'Cenacle ID cannot be reached right now. Try again in a moment.',
      exchange: 'The server did not accept the sign-in. Try again.',
    },
    retry: 'Try again',
    close: 'Close',
    notKept:
      'This computer has no encrypted key store, so you stay signed in only until Cenacle quits.',
  },
  offline: {
    title: 'Cenacle cannot reach {{host}}',
    lede: 'Check your connection. Cenacle tries again on its own.',
    retry: 'Try now',
    changeServer: 'Change server',
  },
  update: {
    availableTitle: 'Cenacle {{version}} is available',
    available: 'Download it now? Cenacle restarts to install it when you choose.',
    download: 'Download',
    later: 'Later',
    readyTitle: 'Cenacle {{version}} is ready',
    ready: 'Restart Cenacle to finish updating.',
    restart: 'Restart now',
    none: 'You have the newest Cenacle.',
    failed: 'Checking for updates did not work.',
    package:
      'Cenacle {{version}} is available. Install it with your package manager or from your server’s download page.',
    ok: 'OK',
  },
  external: {
    loading: 'Opening {{host}}…',
  },
  frame: {
    back: 'Back',
    reload: 'Reload',
    secure: 'Secure connection',
    insecure: 'Not a secure connection',
  },
};

type Texts = typeof en;

const tr: Texts = {
  appName: 'Cenacle',
  menu: {
    file: 'Dosya',
    changeServer: 'Sunucuyu değiştir…',
    signOut: 'Çıkış yap',
    closeToTray: 'Kapatınca tepside çalışmaya devam et',
    quit: 'Cenacle’dan çık',
    edit: 'Düzen',
    view: 'Görünüm',
    reload: 'Yeniden yükle',
    actualSize: 'Gerçek boyut',
    zoomIn: 'Yakınlaştır',
    zoomOut: 'Uzaklaştır',
    fullScreen: 'Tam ekran',
    window: 'Pencere',
    help: 'Yardım',
    about: 'Cenacle hakkında',
    checkUpdates: 'Güncellemeleri denetle…',
    show: 'Cenacle’ı göster',
  },
  pair: {
    title: 'Cenacle sunucuna bağlan',
    lede: 'Kuruluşunun Cenacle sunucusunun adresini gir. Bu adresi BT ekibin verir.',
    address: 'Sunucu adresi',
    example: 'Örneğin chat.sirketin.com',
    connect: 'Devam',
    connecting: 'Sunucu denetleniyor…',
    recent: 'Daha önce kullanılanlar',
    remove: '{{origin}} adresini listeden çıkar',
    next: 'Sonra kullanıcı adın ve parolanla, ardından doğrulama uygulamandaki kodla giriş yaparsın.',
    errors: {
      invalid: 'Bu bir sunucu adresi değil. Denetleyip yeniden dene.',
      insecure:
        'Sunucu https kullanmalı. Düz http yalnızca bu bilgisayar (localhost) için çalışır.',
      unreachable: 'Sunucuya ulaşılamıyor. Adresi ve bağlantını denetle.',
      notCenacle: 'Bu adres bir Cenacle sunucusu gibi yanıt vermiyor.',
      tooOld:
        'Bu sunucu Cenacle {{version}} ya da daha yenisini istiyor. Önce uygulamayı güncelle.',
    },
  },
  signIn: {
    title: '{{host}} adresine giriş',
    failedTitle: 'Giriş olmadı',
    failed: {
      cancelled: 'Giriş iptal edildi.',
      expired: 'Giriş çok uzun sürdü. Yeniden dene.',
      failed: 'Cenacle ID’nin yanıtı doğrulanamadı. Yeniden dene.',
      unavailable: 'Cenacle ID’ye şu an ulaşılamıyor. Birazdan yeniden dene.',
      exchange: 'Sunucu girişi kabul etmedi. Yeniden dene.',
    },
    retry: 'Yeniden dene',
    close: 'Kapat',
    notKept: 'Bu bilgisayarda şifreli anahtar deposu yok; Cenacle kapanana kadar girişli kalırsın.',
  },
  offline: {
    title: 'Cenacle {{host}} adresine ulaşamıyor',
    lede: 'Bağlantını denetle. Cenacle kendiliğinden yeniden dener.',
    retry: 'Şimdi dene',
    changeServer: 'Sunucuyu değiştir',
  },
  update: {
    availableTitle: 'Cenacle {{version}} hazır',
    available: 'Şimdi indirilsin mi? Kurmak için Cenacle’ı sen istediğinde yeniden başlatırız.',
    download: 'İndir',
    later: 'Sonra',
    readyTitle: 'Cenacle {{version}} kurulmaya hazır',
    ready: 'Güncellemeyi bitirmek için Cenacle’ı yeniden başlat.',
    restart: 'Şimdi yeniden başlat',
    none: 'Cenacle’ın en yeni sürümü sende.',
    failed: 'Güncellemeler denetlenemedi.',
    package:
      'Cenacle {{version}} çıktı. Paket yöneticinle ya da sunucunun indirme sayfasından kur.',
    ok: 'Tamam',
  },
  external: {
    loading: '{{host}} açılıyor…',
  },
  frame: {
    back: 'Geri',
    reload: 'Yenile',
    secure: 'Güvenli bağlantı',
    insecure: 'Güvenli olmayan bağlantı',
  },
};

let texts: Texts = en;

export function setupLanguage(): void {
  texts = app.getLocale().toLowerCase().startsWith('tr') ? tr : en;
}

export const language = () => (texts === tr ? 'tr' : 'en');

/** The texts of the app's language. */
export const t = () => texts;

/** Fills {{name}} placeholders. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => values[k] ?? '');
}

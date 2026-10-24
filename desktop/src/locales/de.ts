// SPDX-License-Identifier: AGPL-3.0-only
import type { Texts } from '../i18n.js';

export const de: Texts = {
  appName: 'Cenacle',
  menu: {
    file: 'Datei',
    changeServer: 'Server wechseln…',
    signOut: 'Abmelden',
    closeToTray: 'Beim Schließen im Infobereich weiterlaufen',
    quit: 'Cenacle beenden',
    edit: 'Bearbeiten',
    view: 'Ansicht',
    reload: 'Neu laden',
    actualSize: 'Originalgröße',
    zoomIn: 'Vergrößern',
    zoomOut: 'Verkleinern',
    fullScreen: 'Vollbild',
    window: 'Fenster',
    help: 'Hilfe',
    about: 'Über Cenacle',
    checkUpdates: 'Nach Updates suchen…',
    show: 'Cenacle anzeigen',
  },
  pair: {
    title: 'Mit Ihrem Cenacle-Server verbinden',
    lede: 'Geben Sie die Adresse des Cenacle-Servers Ihrer Organisation ein. Diese Adresse erhalten Sie von Ihrer IT-Abteilung.',
    address: 'Serveradresse',
    example: 'Zum Beispiel chat.ihrefirma.de',
    connect: 'Weiter',
    connecting: 'Server wird geprüft…',
    recent: 'Zuvor verwendet',
    remove: '{{origin}} aus der Liste entfernen',
    next: 'Anschließend melden Sie sich mit Benutzername und Passwort an, danach mit einem Code aus Ihrer Authenticator-App.',
    errors: {
      invalid: 'Dies ist keine Serveradresse. Prüfen Sie sie und versuchen Sie es erneut.',
      insecure:
        'Der Server muss https verwenden. Einfaches http funktioniert nur für diesen Computer (localhost).',
      unreachable: 'Der Server ist nicht erreichbar. Prüfen Sie die Adresse und Ihre Verbindung.',
      notCenacle: 'Diese Adresse antwortet nicht wie ein Cenacle-Server.',
      tooOld:
        'Dieser Server erfordert Cenacle {{version}} oder neuer. Aktualisieren Sie zuerst die App.',
    },
  },
  signIn: {
    title: 'Bei {{host}} anmelden',
    failedTitle: 'Die Anmeldung hat nicht funktioniert',
    failed: {
      cancelled: 'Die Anmeldung wurde abgebrochen.',
      expired: 'Die Anmeldung hat zu lange gedauert. Versuchen Sie es erneut.',
      failed: 'Die Antwort von Cenacle ID konnte nicht überprüft werden. Versuchen Sie es erneut.',
      unavailable: 'Cenacle ID ist gerade nicht erreichbar. Versuchen Sie es gleich erneut.',
      exchange: 'Der Server hat die Anmeldung nicht akzeptiert. Versuchen Sie es erneut.',
    },
    retry: 'Erneut versuchen',
    close: 'Schließen',
    notKept:
      'Dieser Computer hat keinen verschlüsselten Schlüsselspeicher. Sie bleiben daher nur angemeldet, bis Cenacle beendet wird.',
  },
  offline: {
    title: 'Cenacle kann {{host}} nicht erreichen',
    lede: 'Prüfen Sie Ihre Verbindung. Cenacle versucht es automatisch erneut.',
    retry: 'Jetzt versuchen',
    changeServer: 'Server wechseln',
  },
  update: {
    availableTitle: 'Cenacle {{version}} ist verfügbar',
    available: 'Jetzt herunterladen? Cenacle startet zur Installation neu, wann Sie es wünschen.',
    download: 'Herunterladen',
    later: 'Später',
    readyTitle: 'Cenacle {{version}} ist bereit',
    ready: 'Starten Sie Cenacle neu, um das Update abzuschließen.',
    restart: 'Jetzt neu starten',
    none: 'Sie verwenden die neueste Version von Cenacle.',
    failed: 'Die Suche nach Updates hat nicht funktioniert.',
    package:
      'Cenacle {{version}} ist verfügbar. Installieren Sie es mit Ihrer Paketverwaltung oder über die Download-Seite Ihres Servers.',
    ok: 'OK',
  },
  external: {
    loading: '{{host}} wird geöffnet…',
  },
  frame: {
    back: 'Zurück',
    reload: 'Neu laden',
    secure: 'Sichere Verbindung',
    insecure: 'Keine sichere Verbindung',
  },
};

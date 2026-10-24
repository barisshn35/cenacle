// SPDX-License-Identifier: AGPL-3.0-only
import type { Texts } from '../i18n.js';

export const fr: Texts = {
  appName: 'Cenacle',
  menu: {
    file: 'Fichier',
    changeServer: 'Changer de serveur…',
    signOut: 'Se déconnecter',
    closeToTray: 'Continuer dans la zone de notification après fermeture',
    quit: 'Quitter Cenacle',
    edit: 'Édition',
    view: 'Affichage',
    reload: 'Recharger',
    actualSize: 'Taille réelle',
    zoomIn: 'Zoom avant',
    zoomOut: 'Zoom arrière',
    fullScreen: 'Plein écran',
    window: 'Fenêtre',
    help: 'Aide',
    about: 'À propos de Cenacle',
    checkUpdates: 'Rechercher des mises à jour…',
    show: 'Afficher Cenacle',
  },
  pair: {
    title: 'Connectez-vous à votre serveur Cenacle',
    lede: 'Saisissez l’adresse du serveur Cenacle de votre organisation. Votre service informatique vous la communique.',
    address: 'Adresse du serveur',
    example: 'Par exemple chat.votreentreprise.com',
    connect: 'Continuer',
    connecting: 'Vérification du serveur…',
    recent: 'Déjà utilisés',
    remove: 'Retirer {{origin}} de la liste',
    next: 'Vous vous connecterez ensuite avec votre nom d’utilisateur et votre mot de passe, puis avec un code de votre application d’authentification.',
    errors: {
      invalid: 'Ce n’est pas une adresse de serveur. Vérifiez-la et réessayez.',
      insecure:
        'Le serveur doit utiliser https. Le http simple ne fonctionne que pour cet ordinateur (localhost).',
      unreachable: 'Le serveur est injoignable. Vérifiez l’adresse et votre connexion.',
      notCenacle: 'Cette adresse ne répond pas comme un serveur Cenacle.',
      tooOld:
        'Ce serveur nécessite Cenacle {{version}} ou une version plus récente. Mettez d’abord l’application à jour.',
    },
  },
  signIn: {
    title: 'Se connecter à {{host}}',
    failedTitle: 'La connexion a échoué',
    failed: {
      cancelled: 'La connexion a été annulée.',
      expired: 'La connexion a pris trop de temps. Réessayez.',
      failed: 'La réponse de Cenacle ID n’a pas pu être vérifiée. Réessayez.',
      unavailable: 'Cenacle ID est injoignable pour le moment. Réessayez dans un instant.',
      exchange: 'Le serveur n’a pas accepté la connexion. Réessayez.',
    },
    retry: 'Réessayer',
    close: 'Fermer',
    notKept:
      'Cet ordinateur n’a pas de trousseau chiffré : vous restez connecté uniquement jusqu’à la fermeture de Cenacle.',
  },
  offline: {
    title: 'Cenacle ne parvient pas à joindre {{host}}',
    lede: 'Vérifiez votre connexion. Cenacle réessaie automatiquement.',
    retry: 'Réessayer maintenant',
    changeServer: 'Changer de serveur',
  },
  update: {
    availableTitle: 'Cenacle {{version}} est disponible',
    available:
      'La télécharger maintenant ? Cenacle redémarrera pour l’installer quand vous le souhaiterez.',
    download: 'Télécharger',
    later: 'Plus tard',
    readyTitle: 'Cenacle {{version}} est prêt',
    ready: 'Redémarrez Cenacle pour terminer la mise à jour.',
    restart: 'Redémarrer maintenant',
    none: 'Vous disposez de la dernière version de Cenacle.',
    failed: 'La recherche de mises à jour a échoué.',
    package:
      'Cenacle {{version}} est disponible. Installez-le avec votre gestionnaire de paquets ou depuis la page de téléchargement de votre serveur.',
    ok: 'OK',
  },
  external: {
    loading: 'Ouverture de {{host}}…',
  },
  frame: {
    back: 'Retour',
    reload: 'Recharger',
    secure: 'Connexion sécurisée',
    insecure: 'Connexion non sécurisée',
  },
};

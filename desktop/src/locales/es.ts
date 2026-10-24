// SPDX-License-Identifier: AGPL-3.0-only
import type { Texts } from '../i18n.js';

export const es: Texts = {
  appName: 'Cenacle',
  menu: {
    file: 'Archivo',
    changeServer: 'Cambiar de servidor…',
    signOut: 'Cerrar sesión',
    closeToTray: 'Seguir en la bandeja del sistema al cerrar',
    quit: 'Salir de Cenacle',
    edit: 'Edición',
    view: 'Ver',
    reload: 'Recargar',
    actualSize: 'Tamaño real',
    zoomIn: 'Acercar',
    zoomOut: 'Alejar',
    fullScreen: 'Pantalla completa',
    window: 'Ventana',
    help: 'Ayuda',
    about: 'Acerca de Cenacle',
    checkUpdates: 'Buscar actualizaciones…',
    show: 'Mostrar Cenacle',
  },
  pair: {
    title: 'Conéctate a tu servidor de Cenacle',
    lede: 'Introduce la dirección del servidor de Cenacle de tu organización. Tu departamento de TI te da esta dirección.',
    address: 'Dirección del servidor',
    example: 'Por ejemplo chat.tuempresa.com',
    connect: 'Continuar',
    connecting: 'Comprobando el servidor…',
    recent: 'Usados antes',
    remove: 'Quitar {{origin}} de la lista',
    next: 'A continuación inicias sesión con tu nombre de usuario y contraseña y luego con un código de tu aplicación de autenticación.',
    errors: {
      invalid: 'Esto no es una dirección de servidor. Revísala e inténtalo de nuevo.',
      insecure:
        'El servidor debe usar https. http sin cifrar solo funciona para este equipo (localhost).',
      unreachable: 'No se puede acceder al servidor. Comprueba la dirección y tu conexión.',
      notCenacle: 'Esta dirección no responde como un servidor de Cenacle.',
      tooOld:
        'Este servidor necesita Cenacle {{version}} o posterior. Actualiza primero la aplicación.',
    },
  },
  signIn: {
    title: 'Iniciar sesión en {{host}}',
    failedTitle: 'No se pudo iniciar sesión',
    failed: {
      cancelled: 'Se canceló el inicio de sesión.',
      expired: 'El inicio de sesión tardó demasiado. Inténtalo de nuevo.',
      failed: 'No se pudo verificar la respuesta de Cenacle ID. Inténtalo de nuevo.',
      unavailable:
        'No se puede acceder a Cenacle ID en este momento. Inténtalo de nuevo en un momento.',
      exchange: 'El servidor no aceptó el inicio de sesión. Inténtalo de nuevo.',
    },
    retry: 'Reintentar',
    close: 'Cerrar',
    notKept:
      'Este equipo no tiene un almacén de claves cifrado, así que tu sesión solo se mantiene hasta que Cenacle se cierre.',
  },
  offline: {
    title: 'Cenacle no puede acceder a {{host}}',
    lede: 'Comprueba tu conexión. Cenacle lo vuelve a intentar por su cuenta.',
    retry: 'Intentar ahora',
    changeServer: 'Cambiar de servidor',
  },
  update: {
    availableTitle: 'Cenacle {{version}} está disponible',
    available: '¿Descargarlo ahora? Cenacle se reinicia para instalarlo cuando tú elijas.',
    download: 'Descargar',
    later: 'Más tarde',
    readyTitle: 'Cenacle {{version}} está listo',
    ready: 'Reinicia Cenacle para terminar de actualizar.',
    restart: 'Reiniciar ahora',
    none: 'Tienes la versión más reciente de Cenacle.',
    failed: 'No se pudieron buscar actualizaciones.',
    package:
      'Cenacle {{version}} está disponible. Instálalo con tu gestor de paquetes o desde la página de descargas de tu servidor.',
    ok: 'Aceptar',
  },
  external: {
    loading: 'Abriendo {{host}}…',
  },
  frame: {
    back: 'Atrás',
    reload: 'Recargar',
    secure: 'Conexión segura',
    insecure: 'Conexión no segura',
  },
};

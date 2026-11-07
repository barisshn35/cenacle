; SPDX-License-Identifier: AGPL-3.0-only
; Additions to the Windows installer (electron-builder includes this file).

; The logo fades in and out as the installer starts (not in silent installs).
; AdvSplash is one of NSIS's own plugins (zlib licence).
!macro customInit
  ${IfNot} ${Silent}
    InitPluginsDir
    File /oname=$PLUGINSDIR\splash.bmp "${BUILD_RESOURCES_DIR}\installerSplash.bmp"
    advsplash::show 1400 450 350 -1 "$PLUGINSDIR\splash.bmp"
    Pop $0
    Delete "$PLUGINSDIR\splash.bmp"
  ${EndIf}
!macroend

; A welcome page first, with the side picture, in the installer's language.
!macro customWelcomePage
  !insertmacro MUI_PAGE_WELCOME
!macroend

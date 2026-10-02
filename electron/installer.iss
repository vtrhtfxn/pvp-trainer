; PvP Trainer for Windows: the installer the build workflow makes with Inno Setup.
;   ISCC electron\installer.iss    (after `node electron/build-app.mjs --win` on Windows)
; Installs for the current user only (no admin prompt) into %LOCALAPPDATA%\Programs, with a
; Start menu entry, a desktop shortcut and an uninstaller. Installing a newer one over it updates
; it in place; the game itself updates on its own from the app.

#define BuildNumber GetEnv("BUILD")
#if BuildNumber == ""
  #define BuildNumber "0"
#endif

[Setup]
AppId={{8C1B4E52-3D7A-4F0B-9B57-2A6E1C9D4F31}
AppName=PvP Trainer
AppVersion=1.{#BuildNumber}
AppVerName=PvP Trainer (build {#BuildNumber})
AppPublisher=PvP Trainer
AppPublisherURL=https://github.com/vtrhtfxn/pvp-trainer
AppSupportURL=https://github.com/vtrhtfxn/pvp-trainer/releases
DefaultDirName={localappdata}\Programs\PvP Trainer
DefaultGroupName=PvP Trainer
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist-app
OutputBaseFilename=PvP-Trainer-Setup
SetupIconFile=icon.ico
UninstallDisplayIcon={app}\PvP Trainer.exe
UninstallDisplayName=PvP Trainer
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"

[InstallDelete]
; An update replaces the app whole, so no file of an older version is left behind.
Type: filesandordirs; Name: "{app}\resources"
Type: filesandordirs; Name: "{app}\locales"

[Files]
Source: "..\dist-app\PvP Trainer\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\PvP Trainer"; Filename: "{app}\PvP Trainer.exe"
Name: "{autodesktop}\PvP Trainer"; Filename: "{app}\PvP Trainer.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\PvP Trainer.exe"; Description: "Play PvP Trainer now"; Flags: nowait postinstall skipifsilent

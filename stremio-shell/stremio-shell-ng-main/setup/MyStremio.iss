; MyStremio installer (Inno Setup 6)

#define MyAppName "MyStremio"
#define MyAppExeName "mystremio-shell.exe"
#define ReleaseDir SourcePath + "..\target\x86_64-pc-windows-msvc\release\"
#define MyAppExeLocation ReleaseDir + MyAppExeName
#define MyAppVersion() GetVersionComponents(MyAppExeLocation, Local[0], Local[1], Local[2], Local[3]), \
  Str(Local[0]) + "." + Str(Local[1]) + "." + Str(Local[2])

#define MyAppPublisher "MyStremio"
#define MyAppCopyright "Copyright (c) " + GetDateTimeString('yyyy', '', '') + " " + MyAppPublisher
#define MyAppURL "https://github.com/"
#define AssocTorrentExt ".torrent"
#define AssocTorrentKey StringChange(MyAppName, " ", "") + AssocTorrentExt
#define AssocTorrentDesc "Bittorrent seed file"

#define public Dependency_NoExampleSetup
#include "CodeDependencies.iss"

[Setup]
AppId={{C4A8E2F1-7B3D-4E56-9C1A-2F5E8D0B4A6C}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppCopyright={#MyAppCopyright}
AppPublisherURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
SetupMutex=MyStremioSetupsMutex,Global\MyStremioSetupsMutex
PrivilegesRequired=lowest
DisableReadyPage=yes
DisableDirPage=yes
DisableProgramGroupPage=yes
ChangesAssociations=yes
OutputBaseFilename=MyStremioSetup-v{#MyAppVersion}_x64
OutputDir=..\..\..\release
Compression=lzma
SolidCompression=yes
WizardStyle=modern
LanguageDetectionMethod=uilanguage
ShowLanguageDialog=auto
CloseApplications=yes
WizardImageFile={#SourcePath}..\images\windows-installer.bmp
WizardSmallImageFile={#SourcePath}..\images\windows-installer-header.bmp
SetupIconFile={#SourcePath}..\images\stremio.ico
UninstallDisplayIcon={app}\{#MyAppExeName},0

[Code]
function InitializeSetup: Boolean;
begin
  Dependency_AddWebView2;
  Result := True;
end;

function ShouldSkipPage(PageID: Integer): Boolean;
begin
  if (PageID = wpFinished) and WizardIsTaskSelected('runapp') then
    Result := True
  else
    Result := False;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  case (CurPageID) of
    wpSelectTasks: WizardForm.NextButton.Caption := SetupMessage(msgButtonInstall);
    wpFinished: WizardForm.NextButton.Caption := SetupMessage(msgButtonFinish);
  else
    WizardForm.NextButton.Caption := SetupMessage(msgButtonNext);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if (CurStep = ssDone) and WizardIsTaskSelected('runapp') then
    ExecAsOriginalUser(ExpandConstant('{app}\{#MyAppExeName}'), '', '', SW_SHOW, ewNoWait, ResultCode);
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usPostUninstall then
    if MsgBox(ExpandConstant('{cm:RemoveDataFolder}'), mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{userappdata}\MyStremio'), True, True, True);
end;

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"
Name: "german"; MessagesFile: "compiler:Languages\German.isl"

[CustomMessages]
english.RemoveDataFolder=Remove all MyStremio data and configuration from AppData?
german.RemoveDataFolder=Alle MyStremio-Daten und Einstellungen aus AppData entfernen?

[Tasks]
Name: "runapp"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"
Name: "assoctorrent"; Description: "Associate {#MyAppName} with .torrent files"

[Files]
Source: "{#ReleaseDir}{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}libmpv-2.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}ffmpeg.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}ffprobe.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}stremio-runtime.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}server.js"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}avcodec-58.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}avdevice-58.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}avfilter-7.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}avformat-58.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}avutil-56.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}postproc-55.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}swresample-3.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}swscale-5.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}vcruntime140.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}vcruntime140_1.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#ReleaseDir}plugins\*"; DestDir: "{app}\plugins"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#ReleaseDir}themes\*"; DestDir: "{app}\themes"; Flags: ignoreversion recursesubdirs createallsubdirs

[Registry]
Root: HKA; Subkey: "Software\Classes\{#AssocTorrentExt}}\OpenWithProgids"; ValueType: string; ValueName: "{#AssocTorrentKey}"; ValueData: ""; Flags: uninsdeletevalue; Tasks: assoctorrent
Root: HKA; Subkey: "Software\Classes\{#AssocTorrentKey}"; ValueType: string; ValueName: ""; ValueData: "{#AssocTorrentDesc}"; Flags: uninsdeletekey; Tasks: assoctorrent
Root: HKA; Subkey: "Software\Classes\{#AssocTorrentKey}\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Flags: uninsdeletekey; Tasks: assoctorrent
Root: HKA; Subkey: "Software\Classes\{#AssocTorrentKey}\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey; Tasks: assoctorrent
Root: HKA; Subkey: "Software\Classes\stremio"; ValueType: string; ValueName: ""; ValueData: "URL:Stremio Protocol"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\stremio"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\stremio\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\stremio\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\magnet"; ValueType: string; ValueName: ""; ValueData: "URL:BitTorrent magnet"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\magnet"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\magnet\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\{#MyAppExeName},0"; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\magnet\shell\open\command"; ValueType: string; ValueName: ""; ValueData: """{app}\{#MyAppExeName}"" ""%1"""; Flags: uninsdeletekey

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

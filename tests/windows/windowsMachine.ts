import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What the Windows installer check reads of the PC it installed on, through
 * Windows PowerShell (docs/windows.md, "The checks"). Each read's inputs
 * ride the environment, never a script's text, and it answers JSON.
 */

/** Windows PowerShell 5.1, which every Windows 11 carries. */
export const powershellPath = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe",
);

/**
 * Windows PowerShell 5.1 writes to a pipe in the console's code page, which
 * cannot hold every letter the app's words use (accents, typographic
 * apostrophes), so each read answers in UTF-8, as it is decoded.
 */
const UTF8_OUTPUT = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; ";

function run(command: string, env: Record<string, string>): string {
  return execFileSync(
    powershellPath,
    ["-NoProfile", "-NonInteractive", "-Command", UTF8_OUTPUT + command],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
      windowsHide: true,
    },
  ).trim();
}

/** Runs a Windows PowerShell script that answers one value, and parses its JSON. */
export function ps<T>(script: string, env: Record<string, string> = {}): T {
  // A subexpression, since a script ending in a statement (an if) cannot be piped.
  const out = run(`$(${script}) | ConvertTo-Json -Depth 4 -Compress`, env);
  return (out ? JSON.parse(out) : null) as T;
}

/**
 * Runs a Windows PowerShell script that answers a list, one JSON line per
 * item: Windows PowerShell 5.1 turns a whole array given to ConvertTo-Json
 * into an object of its value and Count, so no array is ever converted.
 */
export function psList<T>(script: string, env: Record<string, string> = {}): T[] {
  const out = run(`@(${script}) | ForEach-Object { $_ | ConvertTo-Json -Depth 4 -Compress }`, env);
  return out
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

/** The app's removal entry in Windows Settings, for this person (HKCU) or for everyone (HKLM). */
export type RemovalEntry = {
  readonly hive: "HKCU" | "HKLM";
  readonly DisplayName: string;
  readonly UninstallString: string;
};

export function removalEntries(): RemovalEntry[] {
  return psList<RemovalEntry>(`
    foreach ($hive in 'HKCU','HKLM') {
      Get-ChildItem "$($hive):\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall" -ErrorAction SilentlyContinue |
        ForEach-Object { Get-ItemProperty $_.PSPath } |
        Where-Object { $_.DisplayName -like 'Infinitary*' } |
        ForEach-Object { [pscustomobject]@{ hive = $hive; DisplayName = $_.DisplayName; UninstallString = $_.UninstallString } }
    }`);
}

export function uninstallerOf(entry: RemovalEntry): string {
  return /^"([^"]+)"/.exec(entry.UninstallString)?.[1] ?? entry.UninstallString;
}

/** The Start menu entry for this person, and the app identity Windows reads from it. */
export function startMenuEntry(): { readonly link: string; readonly appId: string | null } | null {
  return ps(`
    $link = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Infinitary.lnk'
    if (-not (Test-Path -LiteralPath $link)) { $null } else {
      $app = Get-StartApps | Where-Object { $_.Name -eq 'Infinitary' } | Select-Object -First 1
      [pscustomobject]@{ link = $link; appId = $app.AppID }
    }`);
}

/** Each running Infinitary.exe started by something other than Infinitary itself, with that parent's name. */
export function topAppProcesses(): { readonly pid: number; readonly parent: string }[] {
  return psList(`
    $all = Get-CimInstance Win32_Process
    $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $all | Where-Object { $_.Name -eq 'Infinitary.exe' } | ForEach-Object {
      $parent = $byId[[int]$_.ParentProcessId]
      if (-not $parent -or $parent.Name -ne 'Infinitary.exe') {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parent = if ($parent) { $parent.Name } else { '' } }
      }
    }`);
}

/** Each running `Infinitary.exe run`, the command with no window, with the name of what started it; never a `work run`. */
export function runProcesses(): { readonly pid: number; readonly parent: string }[] {
  return psList(`
    $all = Get-CimInstance Win32_Process
    $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $all | Where-Object { $_.Name -eq 'Infinitary.exe' -and $_.CommandLine -match '\\s"?run"?(\\s|$)' -and $_.CommandLine -notmatch '\\s"?work"?\\s+"?run' } | ForEach-Object {
      $parent = $byId[[int]$_.ParentProcessId]
      if (-not $parent -or $parent.Name -ne 'Infinitary.exe') {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parent = if ($parent) { $parent.Name } else { '' } }
      }
    }`);
}

/** Each running `Infinitary.exe work run`, the work a home gives this computer, with the name of what started it. */
export function workRunProcesses(): { readonly pid: number; readonly parent: string }[] {
  return psList(`
    $all = Get-CimInstance Win32_Process
    $byId = @{}; foreach ($p in $all) { $byId[[int]$p.ProcessId] = $p }
    $all | Where-Object { $_.Name -eq 'Infinitary.exe' -and $_.CommandLine -match '\\s"?work"?\\s+"?run"?(\\s|$)' } | ForEach-Object {
      $parent = $byId[[int]$_.ParentProcessId]
      if (-not $parent -or $parent.Name -ne 'Infinitary.exe') {
        [pscustomobject]@{ pid = [int]$_.ProcessId; parent = if ($parent) { $parent.Name } else { '' } }
      }
    }`);
}

/** The run's task in this person's Task Scheduler, as Task Scheduler reads it; null for none. */
export type RunTask = {
  readonly state: string;
  /** What the task's last run ended with, as Task Scheduler records it. */
  readonly lastResult: string;
  readonly execute: string;
  readonly arguments: string;
  readonly userId: string;
  readonly logonType: string;
  /** Each sign-in trigger, on or off, one word each: Windows PowerShell 5.1 mangles a list in JSON. */
  readonly signInTriggers: string;
};

export function runTask(name: string): RunTask | null {
  return ps<RunTask | null>(
    `
    $task = Get-ScheduledTask -TaskPath '\\' -TaskName $env:RUN_TASK -ErrorAction SilentlyContinue
    if (-not $task) { $null } else {
      [pscustomobject]@{
        state = [string]$task.State
        lastResult = [string]($task | Get-ScheduledTaskInfo).LastTaskResult
        execute = [string]$task.Actions[0].Execute
        arguments = [string]$task.Actions[0].Arguments
        userId = [string]$task.Principal.UserId
        logonType = [string]$task.Principal.LogonType
        signInTriggers = @($task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger' } | ForEach-Object { if ($_.Enabled) { 'on' } else { 'off' } }) -join ' '
      }
    }`,
    { RUN_TASK: name },
  );
}

export function stillRunning(pids: readonly number[]): number[] {
  return psList<number>(
    `$env:CHECK_PIDS -split ' ' | Where-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue } | ForEach-Object { [int]$_ }`,
    { CHECK_PIDS: pids.join(" ") },
  );
}

/**
 * Presses a button of a system dialog the process shows, by its words,
 * through Windows' accessibility tree, as a person's click would; false
 * while no such button shows. The element carrying the words may be the
 * button's label rather than the button, so the press goes to the nearest
 * element that can be pressed; a classic dialog's button that offers no
 * such pattern gets its window's own click message; failing both, the
 * task dialog's button, which shows no pattern either, gets its dialog's
 * own click message. None of these needs the dialog in front, where
 * another window, such as OneDrive's backup prompt, may stay. When nothing
 * could be pressed and treeFile is given, the dialog's accessibility tree
 * is written there.
 */
export function pressDialogButton(pid: number, button: string, treeFile?: string): boolean {
  return ps<boolean>(
    `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    $invoke = [System.Windows.Automation.InvokePattern]::Pattern
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $byProcess = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$env:DIALOG_PID)
    $byName = New-Object System.Windows.Automation.PropertyCondition($A::NameProperty, $env:DIALOG_BUTTON)
    $pressed = $false
    $tree = @()
    foreach ($window in $A::RootElement.FindAll('Children', $byProcess)) {
      foreach ($candidate in $window.FindAll('Descendants', $byName)) {
        $e = $candidate
        for ($i = 0; $i -lt 3 -and $e -and -not $pressed; $i++) {
          if (@($e.GetSupportedPatterns() | ForEach-Object { $_.Id }) -contains $invoke.Id) {
            $e.GetCurrentPattern($invoke).Invoke()
            $pressed = $true
          } else { $e = $walker.GetParent($e) }
        }
        # A classic dialog's button, which offers no pattern while its
        # window keeps it: the window's own click message presses it.
        if (-not $pressed -and $candidate.Current.ClassName -eq 'Button' -and $candidate.Current.NativeWindowHandle -ne 0) {
          if (-not ('InfDialog.Button' -as [type])) {
            Add-Type -Name Button -Namespace InfDialog -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);'
          }
          $pressed = [InfDialog.Button]::PostMessage([System.IntPtr]$candidate.Current.NativeWindowHandle, 0x00F5, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
        }
        # A task dialog's button, as each of Electron's buttons on Windows is, shows in this tree
        # as a pane that offers no pattern, named by its id (CommandLink_100, CommandButton_1).
        # The dialog's own click message presses that id without the focus and capture the
        # button's own click needs, which a window keeping the front takes away.
        if (-not $pressed -and $candidate.Current.AutomationId -match '^Command(Link|Button)_(\\d+)$' -and [System.Windows.Automation.TreeWalker]::RawViewWalker.GetParent($candidate).Current.ClassName -eq 'TaskDialog' -and $window.Current.NativeWindowHandle -ne 0) {
          if (-not ('InfDialog.Button' -as [type])) {
            Add-Type -Name Button -Namespace InfDialog -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr hWnd, uint msg, System.IntPtr w, System.IntPtr l);'
          }
          # TDM_CLICK_BUTTON
          $pressed = [InfDialog.Button]::PostMessage([System.IntPtr]$window.Current.NativeWindowHandle, 0x0466, [System.IntPtr][int]$Matches[2], [System.IntPtr]::Zero)
        }
        if ($pressed) { break }
      }
      if ($pressed) { break }
      foreach ($e in $window.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) {
        $tree += [pscustomobject]@{
          name = $e.Current.Name; type = $e.Current.ControlType.ProgrammaticName; class = $e.Current.ClassName
          focusable = $e.Current.IsKeyboardFocusable
          patterns = (@($e.GetSupportedPatterns() | ForEach-Object { $_.ProgrammaticName }) -join ',')
        }
      }
    }
    if (-not $pressed -and $env:DIALOG_TREE -and $tree.Count -gt 0) {
      ConvertTo-Json -InputObject $tree -Depth 3 | Set-Content -LiteralPath $env:DIALOG_TREE
    }
    $pressed`,
    { DIALOG_PID: String(pid), DIALOG_BUTTON: button, DIALOG_TREE: treeFile ?? "" },
  );
}

/**
 * Whether the process shows a window a person can see: Windows names a
 * process's main window only while one of its top-level windows is visible.
 */
export function showsWindow(pid: number): boolean {
  return ps<boolean>(
    `$p = Get-Process -Id ([int]$env:SHOWN_PID) -ErrorAction SilentlyContinue
    [bool]($p -and $p.MainWindowHandle -ne [IntPtr]::Zero)`,
    { SHOWN_PID: String(pid) },
  );
}

/**
 * Closes the process's visible window as a person's click on its close
 * button does: Windows sends that window the same close message. False
 * when it shows none.
 */
export function closeShownWindow(pid: number): boolean {
  return ps<boolean>(
    `$p = Get-Process -Id ([int]$env:CLOSE_PID) -ErrorAction SilentlyContinue
    [bool]($p -and $p.CloseMainWindow())`,
    { CLOSE_PID: String(pid) },
  );
}

/**
 * The words of every window `pid` shows, as Windows' accessibility tree
 * reads them: each part's name, its text and its buttons' labels alike.
 */
export function dialogWords(pid: number): string[] {
  return psList<string>(
    `
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $A = [System.Windows.Automation.AutomationElement]
    $byProcess = New-Object System.Windows.Automation.PropertyCondition($A::ProcessIdProperty, [int]$env:DIALOG_PID)
    foreach ($window in $A::RootElement.FindAll('Children', $byProcess)) {
      foreach ($e in $window.FindAll('Descendants', [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($e.Current.Name) { $e.Current.Name }
      }
    }`,
    { DIALOG_PID: String(pid) },
  );
}

/** The installed copy's top processes opened on `dataDir` with `--user-data-dir`. */
export function appProcessesOn(executable: string, dataDir: string): number[] {
  return psList<number>(
    `
    $all = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $env:APP_EXE })
    $ids = @($all | ForEach-Object { $_.ProcessId })
    $all | Where-Object { $ids -notcontains $_.ParentProcessId -and ([string]$_.CommandLine).Contains('"--user-data-dir=' + $env:APP_DATA + '"') } |
      ForEach-Object { [int]$_.ProcessId }`,
    { APP_EXE: executable, APP_DATA: dataDir },
  );
}

export function screenshot(file: string): void {
  ps(
    `
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bitmap = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bitmap)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bitmap.Save($env:SHOT_FILE, [System.Drawing.Imaging.ImageFormat]::Png)
    $true`,
    { SHOT_FILE: file },
  );
}

/**
 * Opens a Windows PowerShell console window, as a person opens one from the
 * Start menu, running the one line given there as a person's paste does;
 * answers its process number. `-NoExit` keeps the window and its words once
 * the line is done, for the check to read.
 */
export function openConsole(line: string): number {
  return ps<number>(
    "(Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-NoExit','-Command','Invoke-Expression $env:CONSOLE_LINE' -PassThru).Id",
    { CONSOLE_LINE: line },
  );
}

/**
 * The console's own parts in Windows: its input takes key presses as a
 * keyboard's reach it, and its screen holds the words it shows. The check
 * leaves its own console and enters the one the process owns.
 */
const CONSOLE_PARTS = `
  Add-Type -TypeDefinition @'
  using System;
  using System.Runtime.InteropServices;
  using System.Text;
  public static class ConsoleParts {
    [StructLayout(LayoutKind.Explicit, Size = 20, CharSet = CharSet.Unicode)]
    public struct Key {
      [FieldOffset(0)] public ushort EventType;
      [FieldOffset(4)] public int KeyDown;
      [FieldOffset(8)] public ushort Repeat;
      [FieldOffset(10)] public ushort VirtualKey;
      [FieldOffset(12)] public ushort ScanCode;
      [FieldOffset(14)] public char Char;
      [FieldOffset(16)] public uint ControlKeys;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct Info { public short Width; public short Height; public short CursorX; public short CursorY; public ushort Attributes; public short Left; public short Top; public short Right; public short Bottom; public short MaxX; public short MaxY; }
    [DllImport("kernel32.dll")] public static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteConsoleInputW(IntPtr input, Key[] keys, uint count, out uint written);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetConsoleScreenBufferInfo(IntPtr output, out Info info);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ReadConsoleOutputCharacterW(IntPtr output, StringBuilder into, uint length, uint at, out uint read);
    static IntPtr Open(string name) { return CreateFileW(name, 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero); }
    static Key Press(char c, ushort vk, bool down) { Key k = new Key(); k.EventType = 1; k.KeyDown = down ? 1 : 0; k.Repeat = 1; k.VirtualKey = vk; k.Char = c; return k; }
    public static bool Type(string words) {
      var keys = new System.Collections.Generic.List<Key>();
      foreach (char c in words) { ushort vk = (ushort)Char.ToUpperInvariant(c); keys.Add(Press(c, vk, true)); keys.Add(Press(c, vk, false)); }
      keys.Add(Press('\\r', 0x0D, true)); keys.Add(Press('\\r', 0x0D, false));
      uint written;
      return WriteConsoleInputW(Open("CONIN$"), keys.ToArray(), (uint)keys.Count, out written) && written == keys.Count;
    }
    public static string Screen() {
      IntPtr output = Open("CONOUT$");
      Info info;
      if (!GetConsoleScreenBufferInfo(output, out info)) return "";
      var into = new StringBuilder(info.Width * (info.CursorY + 1));
      uint read;
      ReadConsoleOutputCharacterW(output, into, (uint)(info.Width * (info.CursorY + 1)), 0, out read);
      var text = into.ToString();
      var lines = new StringBuilder();
      for (int at = 0; at + info.Width <= text.Length; at += info.Width) lines.AppendLine(text.Substring(at, info.Width).TrimEnd());
      return lines.ToString();
    }
  }
'@
  [void][ConsoleParts]::FreeConsole()
  if (-not [ConsoleParts]::AttachConsole([uint32]$env:CONSOLE_PID)) { throw "could not enter the console of $env:CONSOLE_PID" }`;

/** Types words and then Enter into the console the process owns, as a person's keys do. */
export function typeInConsole(pid: number, words: string): boolean {
  return ps<boolean>(`${CONSOLE_PARTS}\n[ConsoleParts]::Type($env:CONSOLE_WORDS)`, {
    CONSOLE_PID: String(pid),
    CONSOLE_WORDS: words,
  });
}

/** The words the console the process owns shows, line by line. */
export function consoleText(pid: number): string {
  return ps<string>(`${CONSOLE_PARTS}\n[ConsoleParts]::Screen()`, { CONSOLE_PID: String(pid) });
}

/** A message-only window a process owns: Windows' class name and its title. */
export type MessageWindow = { readonly className: string; readonly title: string };

/**
 * The message-only windows the process owns. Electron's own single-instance
 * lock on Windows is one of them, titled by the data folder it holds: a
 * launch finds it by that class and title and asks it through Windows' own
 * messages.
 */
export function messageWindows(pid: number): MessageWindow[] {
  return psList<MessageWindow>(
    `
    Add-Type -TypeDefinition @'
    using System;
    using System.Collections.Generic;
    using System.Runtime.InteropServices;
    using System.Text;
    public class MessageWindowRead { public string className { get; set; } public string title { get; set; } }
    public static class MessageWindows {
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
      [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr window, StringBuilder into, int length);
      [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int InternalGetWindowText(IntPtr window, StringBuilder into, int length);
      public static MessageWindowRead[] Of(uint pid) {
        var found = new List<MessageWindowRead>();
        IntPtr window = IntPtr.Zero;
        while ((window = FindWindowExW(new IntPtr(-3), window, null, null)) != IntPtr.Zero) {
          uint owner;
          GetWindowThreadProcessId(window, out owner);
          if (owner != pid) continue;
          var cls = new StringBuilder(256);
          GetClassNameW(window, cls, cls.Capacity);
          var title = new StringBuilder(1024);
          InternalGetWindowText(window, title, title.Capacity);
          found.Add(new MessageWindowRead { className = cls.ToString(), title = title.ToString() });
        }
        return found.ToArray();
      }
    }
'@
    [MessageWindows]::Of([uint32]$env:OWNER_PID)`,
    { OWNER_PID: String(pid) },
  );
}

/**
 * A program that holds a data folder's single-instance lock as an app from
 * before windows answered a launch would, and nothing else: the folder's
 * lock file, held as Electron holds it, and a message-only window of the lock
 * window's own class and title that takes every launch's ask as received and
 * answers nothing in the folder. It counts the asks it takes, so a check
 * reads how often a launch asked it, and lets the lock go when told.
 */
export type StandInHolder = {
  /** How many launches' asks it has taken. */
  readonly asks: () => number;
  /** Lets the lock go and ends, as that app quitting does. */
  readonly letGo: () => Promise<void>;
  /**
   * Lets the lock file go, then its window and ends once a launch asks after that, so a launch
   * watching the folder has seen it free before anything else takes it.
   */
  readonly letGoSeen: () => Promise<void>;
  /** Ends it however it stands, for a check's cleanup. */
  readonly end: () => void;
};

const STAND_IN_HOLDER = `
  $ErrorActionPreference = 'Stop'
  Add-Type -TypeDefinition @'
  using System;
  using System.IO;
  using System.Runtime.InteropServices;
  using System.Threading;
  public static class StandInHolder {
    delegate IntPtr Proc(IntPtr window, uint message, IntPtr w, IntPtr l);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WindowClass { public uint size; public uint style; public Proc proc; public int classExtra; public int windowExtra; public IntPtr instance; public IntPtr icon; public IntPtr cursor; public IntPtr background; public string menu; public string name; public IntPtr smallIcon; }
    [StructLayout(LayoutKind.Sequential)]
    struct Message { public IntPtr window; public uint message; public IntPtr w; public IntPtr l; public uint time; public int x; public int y; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern ushort RegisterClassExW(ref WindowClass c);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowExW(uint extra, string cls, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr window, uint message, IntPtr w, IntPtr l);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out Message m, IntPtr window, uint first, uint last, uint remove);
    [DllImport("user32.dll")] static extern bool TranslateMessage(ref Message m);
    [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref Message m);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr window);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandleW(string name);
    static int asks;
    static string control;
    static Proc kept;
    static IntPtr Take(IntPtr window, uint message, IntPtr w, IntPtr l) {
      // WM_COPYDATA, a launch's ask: taken as received, answered nowhere else.
      if (message == 0x004A) {
        asks++;
        File.WriteAllText(Path.Combine(control, "asks"), asks.ToString());
        return new IntPtr(1);
      }
      return DefWindowProcW(window, message, w, l);
    }
    public static void Hold(string lockFile, string cls, string title, string controlDir) {
      control = controlDir;
      kept = Take;
      var c = new WindowClass();
      c.size = (uint)Marshal.SizeOf(typeof(WindowClass));
      c.proc = kept;
      c.instance = GetModuleHandleW(null);
      c.name = cls;
      if (RegisterClassExW(ref c) == 0) throw new Exception("could not register the class: " + Marshal.GetLastWin32Error());
      // As Electron holds it: written by this program alone, read by others, gone once let go.
      IntPtr file = CreateFileW(lockFile, 0x40000000, 1, IntPtr.Zero, 2, 0x80 | 0x04000000, IntPtr.Zero);
      if (file == new IntPtr(-1)) throw new Exception("could not hold the lock file: " + Marshal.GetLastWin32Error());
      IntPtr window = CreateWindowExW(0, cls, title, 0, 0, 0, 0, 0, new IntPtr(-3), IntPtr.Zero, c.instance, IntPtr.Zero);
      if (window == IntPtr.Zero) throw new Exception("could not make the window: " + Marshal.GetLastWin32Error());
      File.WriteAllText(Path.Combine(control, "holding"), "");
      Message m;
      bool fileHeld = true;
      int asksAtRelease = 0;
      for (;;) {
        while (PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessageW(ref m); }
        if (File.Exists(Path.Combine(control, "let-go"))) break;
        // The lock file first, the window once a launch asks after that: a launch watching the
        // folder has then seen it let go.
        if (fileHeld && File.Exists(Path.Combine(control, "let-go-seen"))) {
          CloseHandle(file);
          fileHeld = false;
          asksAtRelease = asks;
        }
        if (!fileHeld && asks > asksAtRelease) break;
        Thread.Sleep(20);
      }
      DestroyWindow(window);
      if (fileHeld) CloseHandle(file);
    }
  }
'@
  [StandInHolder]::Hold($env:HOLD_LOCK_FILE, $env:HOLD_CLASS, $env:HOLD_TITLE, $env:HOLD_CONTROL)`;

/**
 * Starts a stand-in holder (`StandInHolder`) of the lock window given, read
 * from the app's own (`messageWindows`), on the data folder's lock file, and
 * answers once it holds both. `control` is an empty folder of the check's.
 */
export async function holdLockAsStandIn(options: {
  readonly lockFile: string;
  readonly window: MessageWindow;
  readonly control: string;
}): Promise<StandInHolder> {
  const holder = spawn(
    powershellPath,
    ["-NoProfile", "-NonInteractive", "-Command", STAND_IN_HOLDER],
    {
      env: {
        ...process.env,
        HOLD_LOCK_FILE: options.lockFile,
        HOLD_CLASS: options.window.className,
        HOLD_TITLE: options.window.title,
        HOLD_CONTROL: options.control,
      },
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    },
  );
  let said = "";
  holder.stderr?.on("data", (chunk) => {
    said += String(chunk);
  });
  const ended = new Promise<number | null>((resolve) => holder.once("exit", resolve));
  const holding = join(options.control, "holding");
  for (;;) {
    if (existsSync(holding)) break;
    const code = await Promise.race([
      ended,
      new Promise<"waiting">((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    if (code !== "waiting") throw new Error(`the stand-in holder ended (${code}): ${said}`);
  }
  const asksFile = join(options.control, "asks");
  const letGo = async (file: string) => {
    writeFileSync(join(options.control, file), "");
    const code = await ended;
    if (code !== 0) throw new Error(`the stand-in holder ended (${code}): ${said}`);
  };
  return {
    asks: () => (existsSync(asksFile) ? Number(readFileSync(asksFile, "utf8")) : 0),
    letGo: () => letGo("let-go"),
    letGoSeen: () => letGo("let-go-seen"),
    end: () => {
      if (holder.exitCode === null) holder.kill();
    },
  };
}

/** Each Infinitary.exe the process started itself, with its command line. */
export function childApps(
  parentPid: number,
): { readonly pid: number; readonly commandLine: string }[] {
  return psList(
    `Get-CimInstance Win32_Process -Filter "Name = 'Infinitary.exe'" |
      Where-Object { [int]$_.ParentProcessId -eq [int]$env:PARENT_PID } |
      ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; commandLine = [string]$_.CommandLine } }`,
    { PARENT_PID: String(parentPid) },
  );
}

/** The native input reading distinguishes a disappearing window from a focus failure. */
export type QuitKeyReading = {
  readonly status:
    | "window-missing"
    | "window-lost"
    | "caption-unreachable"
    | "not-foreground"
    | "sent";
  readonly target: number;
  readonly before: { readonly hwnd: number; readonly pid: number };
  readonly after: { readonly hwnd: number; readonly pid: number };
  readonly clicked: boolean;
};

/** Clicks the window's inert drag strip if needed, then sends one real desktop Ctrl+Q. */
export function pressQuitKey(pid: number): QuitKeyReading {
  return ps<QuitKeyReading>(
    `
    $ErrorActionPreference = 'Stop'
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -TypeDefinition @'
    using System;
    using System.Runtime.InteropServices;
    public static class QuitInput {
      [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
      [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
      [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
      [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
      [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
      [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
      [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
      [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr w, IntPtr l, uint flags, uint timeout, out UIntPtr result);
      [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
      [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
      [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);

      public static bool IsTarget(IntPtr window, uint pid) {
        uint owner;
        return window != IntPtr.Zero && GetWindowThreadProcessId(window, out owner) != 0 &&
          owner == pid && IsWindowVisible(window);
      }

      public static bool ClickCaption(IntPtr window) {
        Rect bounds;
        if (!GetWindowRect(window, out bounds)) return false;
        // Look for HTCAPTION in the app's top bar, not its buttons or content.
        // WindowFromPoint also excludes other windows drawn over the app.
        foreach (int x in new[] { 25, 50, 75 }) {
          var p = new Point { x = bounds.left + (bounds.right - bounds.left) * x / 100, y = bounds.top + 24 };
          if (GetAncestor(WindowFromPoint(p), 2) != window) continue; // GA_ROOT
          UIntPtr hit;
          var packed = new IntPtr((p.x & 0xffff) | (p.y << 16));
          if (SendMessageTimeout(window, 0x84, IntPtr.Zero, packed, 2, 250, out hit) == IntPtr.Zero ||
              hit.ToUInt64() != 2) continue; // WM_NCHITTEST, HTCAPTION
          Point cursor;
          if (!SetCursorPos(p.x, p.y) || !GetCursorPos(out cursor) ||
              cursor.x != p.x || cursor.y != p.y || GetAncestor(WindowFromPoint(cursor), 2) != window) return false;
          mouse_event(2, 0, 0, 0, UIntPtr.Zero); // left down
          mouse_event(4, 0, 0, 0, UIntPtr.Zero); // left up
          return true;
        }
        return false;
      }
    }
'@
    function foreground {
      $handle = [QuitInput]::GetForegroundWindow()
      $owner = [uint32]0
      [void][QuitInput]::GetWindowThreadProcessId($handle, [ref]$owner)
      @{ hwnd = $handle.ToInt64(); pid = $owner }
    }
    $targetPid = [uint32]$env:QUIT_PID
    $p = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
    $window = if ($p) { $p.MainWindowHandle } else { [IntPtr]::Zero }
    $before = foreground
    $reading = @{ target = $window.ToInt64(); before = $before; after = $before; clicked = $false }
    if ($window -eq [IntPtr]::Zero) { $reading.status = 'window-missing' }
    elseif (-not [QuitInput]::IsTarget($window, $targetPid)) { $reading.status = 'window-lost' }
    else {
      if ($before.hwnd -ne $window.ToInt64()) {
        $reading.clicked = [QuitInput]::ClickCaption($window)
        if ($reading.clicked) {
          # Wait for Windows to process the one click; never send another.
          $clock = [Diagnostics.Stopwatch]::StartNew()
          while ([QuitInput]::GetForegroundWindow() -ne $window -and
                 [QuitInput]::IsTarget($window, $targetPid) -and $clock.ElapsedMilliseconds -lt 3000) {
            Start-Sleep -Milliseconds 25
          }
        }
      }
      $reading.after = foreground
      if (-not [QuitInput]::IsTarget($window, $targetPid)) { $reading.status = 'window-lost' }
      elseif ($reading.after.hwnd -ne $window.ToInt64()) {
        $reading.status = if ($reading.clicked) { 'not-foreground' } else { 'caption-unreachable' }
      } else {
        [System.Windows.Forms.SendKeys]::SendWait('^q')
        $reading.status = 'sent'
      }
    }
    $reading`,
    { QUIT_PID: String(pid) },
  );
}

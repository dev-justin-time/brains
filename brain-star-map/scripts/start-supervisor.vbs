' Detached launcher for scripts/supervise-all-agents.js.
'
' Resolves this VBS file's directory so the launcher works after the project is
' moved to another Windows host or checkout path. It runs hidden and does not
' wait, so the supervisor survives the launching shell.
'
' Usage:  wscript scripts\start-supervisor.vbs

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
repo = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
script = repo & "\scripts\supervise-all-agents.js"
sh.CurrentDirectory = repo
sh.Run """" & node & """ """ & script & """", 0, False

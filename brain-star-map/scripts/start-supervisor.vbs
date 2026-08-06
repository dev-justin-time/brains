' Detached launcher for scripts/supervise-all-agents.js.
'
' `Start-Process` from a shell still attaches the node process to that shell's
' console, so when the shell exits the console close event hard-kills the
' supervisor (and its whole watchdog tree) without running the SIGTERM
' handler. WScript.Shell.Run with windowStyle=0 (hidden) and bWaitOnReturn=False
' detaches the process from any console entirely — it survives the launching
' shell.
'
' Usage:  wscript scripts\start-supervisor.vbs
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\dividicus\Downloads\brains\brain-star-map"
' Absolute node path (like the Startup-folder .cmd) — wscript swallows launch
' errors silently, so don't rely on `node` being on PATH.
sh.Run "C:\Program Files\nodejs\node.exe scripts/supervise-all-agents.js", 0, False

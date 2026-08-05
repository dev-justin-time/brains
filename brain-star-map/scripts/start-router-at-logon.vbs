' BrainStarMap Router — auto-start at logon (Windows Startup folder).
' Runs the watchdog hidden (window style 0, no wait), which spawns `blocks run`
' for the router and restarts it on crash. No admin required — the Startup
' folder is the standard per-user auto-start mechanism on Windows.
'
' Install: copy this file to
'   %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
' (or re-run `node scripts/install-router-autostart.mjs` if you add one).
'
' Logs land in blocks/logs/router-watchdog.log.

Set sh = CreateObject("Wscript.Shell")
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\dividicus\Downloads\brains\brain-star-map\scripts\watch-blocks-agent.js"" router", 0, False
